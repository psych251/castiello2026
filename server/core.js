/*
 * The chat service's study logic, independent of where it is hosted.
 *
 * The host is the Cloud Function in index.js (through http.js); in the local emulators it runs
 * the simulated model. A host only has to turn an HTTP request into
 * `handle({ method, path, authorization, body })` and supply three things:
 *   verifyToken(idToken) -> { uid }   checks the participant's Firebase anonymous sign-in
 *   store                            reads and writes the private records (store-firestore.js)
 *   model                            generates replies (models.js)
 *
 * Endpoints (JSON in and out):
 *   GET  /health
 *   POST /access   { experiment_id, invite? }
 *        No sign-in. Whether the study is open (and, for an invite-only study, whether the invite
 *        is valid), so the page can stop before signing in or saving anything. Writes nothing.
 *   POST /session  { experiment_id, participant_id, bfi, invite?, force? }
 *        Scores the BFI, draws the order and names, builds both prompts and saves them
 *        privately. Returns only the two bot names in chat order.
 *   POST /status   { experiment_id, participant_id, chat_index, seq }
 *        Read only: whether the service has saved message `seq` and its reply, so the page can say
 *        truthfully that a slow reply's message was received. No model call, nothing written.
 *   POST /end      { experiment_id, participant_id, chat_index, reason }
 *        The participant left (or the page ended the chats). No further model call is made for
 *        the session, a reply still being generated is not saved as shown, and later turns are
 *        refused ("session_ended").
 *   POST /turn     { experiment_id, participant_id, chat_index, seq, text }
 *        One participant message (seq 0 is the hidden request for the bot's opener). Returns
 *        the bot's reply, { reply: { seq, text }, done }. Safe to repeat: the same message
 *        again returns the same reply instead of a second one.
 *
 * Safeguards (2026-10-27, after Pilot B), all before any model call or display:
 *   - a closed study (config `open: false`) refuses every request, existing sessions included;
 *   - a pause (store.getPause: a global or per-study switch in Firestore, set with
 *     scripts/pilot-admin.js, no redeploy) is checked on every request and again before each
 *     model call;
 *   - every model call is counted against config.limits, per reply and per session;
 *   - with a screening profile, each reply is checked (safety.js) before it is saved or sent. A
 *     flagged reply is withheld: kept only in the private `withheld` records, logged as a
 *     "safety_flag" event, and regenerated; after limits.max_flags_per_reply flags that chat is
 *     stopped ("safety_stop") and the participant may continue with the rest of the study.
 *
 * What the browser never receives: the condition labels, the order's meaning, the scores, the
 * prompts, or anything from another participant. Every request is tied to the caller's own
 * sign-in: a participant id must begin with the caller's uid, as in firestore.rules.
 */
"use strict";

const crypto = require("crypto");
const Castiello = require("./castiello.js");
const Safety = require("./safety.js");

// Invite codes are stored only as this hash, so the database never holds a usable code.
const hashInvite = (code) => crypto.createHash("sha256").update(String(code)).digest("hex");
const PROLIFIC_ID = /^[A-Za-z0-9]{1,64}$/;

class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

const ID_PATTERN = /^[A-Za-z0-9]+-[A-Za-z0-9]+$/;

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error("timed out after " + ms + "ms"), { code: "timeout" })), ms); }),
  ]);
}

function createStudyService(opts) {
  const { store, model, config, verifyToken } = opts;
  const now = opts.now || (() => new Date());
  const random = opts.random || Math.random;
  const allowForcedAssignment = !!opts.allowForcedAssignment;
  // The emulators accept a Prolific study whose study_id is not set yet (tests); deployed, it is refused.
  const allowUnconfiguredProlific = !!opts.allowUnconfiguredProlific;
  const log = opts.log || (() => {});

  const pick = (xs) => xs[Math.floor(random() * xs.length)];

  // ---- requests --------------------------------------------------------------

  async function handle(req) {
    try {
      if (req.method === "GET" && req.path === "/health") return { status: 200, body: { ok: true } };
      const body = req.body && typeof req.body === "object" ? req.body : {};
      if (req.method === "POST" && req.path === "/access") return { status: 200, body: await checkAccess(body) };
      if (req.method !== "POST" || !["/session", "/turn", "/end", "/status"].includes(req.path)) {
        throw new ApiError(404, "not_found", "No such endpoint.");
      }
      const uid = await authenticate(req.authorization);
      const ids = checkIds(body, uid);
      if (req.path === "/end") return { status: 200, body: await endSession(uid, ids, body) };
      if (req.path === "/status") return { status: 200, body: await messageStatus(uid, ids, body) };
      await checkNotPaused(ids.experimentId);
      const out = req.path === "/session" ? await startSession(uid, ids, body) : await takeTurn(uid, ids, body);
      return { status: 200, body: out };
    } catch (e) {
      if (e instanceof ApiError) {
        return { status: e.status, body: Object.assign({ error: e.code, message: e.message, retryable: e.status >= 500 }, e.extra) };
      }
      log("internal error: " + ((e && e.message) || e));
      return { status: 500, body: { error: "internal", message: "Something went wrong on the server.", retryable: true } };
    }
  }

  async function authenticate(header) {
    const m = /^Bearer (.+)$/.exec(header || "");
    if (!m) throw new ApiError(401, "unauthenticated", "Missing sign-in token.");
    let user;
    try { user = await verifyToken(m[1]); } catch (e) { user = null; }
    if (!user || !user.uid) throw new ApiError(401, "unauthenticated", "Invalid sign-in token.");
    return user.uid;
  }

  function checkIds(body, uid) {
    const experimentId = body.experiment_id;
    const participantId = body.participant_id;
    checkOpen(experimentId);
    if (typeof participantId !== "string" || !ID_PATTERN.test(participantId) || !participantId.startsWith(uid + "-")) {
      throw new ApiError(403, "not_your_session", "This session does not belong to you.");
    }
    return { experimentId, participantId };
  }

  function checkOpen(experimentId) {
    if (typeof experimentId !== "string" || !Object.prototype.hasOwnProperty.call(config.experiments, experimentId)) {
      throw new ApiError(403, "unknown_experiment", "This study id does not accept chat sessions.");
    }
    if (config.experiments[experimentId].open !== true) {
      throw new ApiError(403, "study_closed", "This study is closed.");
    }
  }

  // Fails closed: if the switch cannot be read, nothing reaches the model.
  async function checkNotPaused(experimentId) {
    let pause;
    try {
      pause = await store.getPause(experimentId);
    } catch (e) {
      log("pause check failed: " + ((e && e.message) || e));
      throw new ApiError(503, "pause_check_failed", "The study cannot be reached right now. Please try again.");
    }
    // A study with default_paused stays paused until its switch is explicitly set to resumed.
    const byDefault = !!(config.experiments[experimentId] || {}).default_paused && !(pause && pause.study_set);
    if ((pause && pause.paused) || byDefault) throw new ApiError(503, "study_paused", "The study has been paused by the researchers.", { retryable: false });
  }

  // ---- POST /access ------------------------------------------------------------

  // A Prolific study: the three Prolific parameters, and the right study. Resolves the checked ids.
  function checkProlific(experimentId, prolific) {
    const p = config.experiments[experimentId].prolific;
    if (!p) return null;
    if (!p.study_id && !allowUnconfiguredProlific) throw new ApiError(403, "study_not_configured", "This study is not set up yet.");
    const x = prolific && typeof prolific === "object" ? prolific : {};
    const ok = ["pid", "study_id", "session_id"].every((k) => typeof x[k] === "string" && PROLIFIC_ID.test(x[k]));
    if (!ok || (p.study_id && x.study_id !== p.study_id)) {
      throw new ApiError(403, "prolific_required", "Please open this study from Prolific.");
    }
    return { pid: x.pid, study_id: x.study_id, session_id: x.session_id };
  }

  async function checkAccess(body) {
    checkOpen(body.experiment_id);
    await checkNotPaused(body.experiment_id);
    checkProlific(body.experiment_id, body.prolific);
    if (config.experiments[body.experiment_id].invite_only) {
      const code = typeof body.invite === "string" ? body.invite.trim() : "";
      const invite = code && code.length <= 200 ? await store.getInvite(body.experiment_id, hashInvite(code)) : null;
      if (!invite || invite.revoked || (invite.uses || 0) >= (invite.max_uses || 0)) {
        throw new ApiError(403, "invite_invalid", "This study link is not valid or has already been used.");
      }
    }
    return { ok: true };
  }

  function profileOf(experimentId) {
    const name = config.experiments[experimentId].prompt_profile;
    const profile = config.prompt_profiles && config.prompt_profiles[name];
    if (!profile || !Castiello.PROMPTS[profile.prompt]) throw new Error("unknown prompt profile " + name + " for " + experimentId);
    return { name, ...profile };
  }

  // ---- POST /session -----------------------------------------------------------

  function publicView(session) {
    return {
      chats: [1, 2].map((i) => ({ chat_index: i, bot_name: session["chat" + i + "_name"] })),
      messages_per_chat: session.messages_per_chat,
      max_message_chars: session.max_message_chars,
    };
  }

  function readBfi(bfi) {
    if (!bfi || typeof bfi !== "object") throw new ApiError(400, "bad_bfi", "Missing questionnaire answers.");
    const clean = {};
    const ok = (v) => v === undefined || v === null || (Number.isInteger(v) && v >= 1 && v <= 5);
    for (const item of Castiello.BFI_ITEMS) {
      if (!ok(bfi[item.id])) throw new ApiError(400, "bad_bfi", "Answers must be whole numbers from 1 to 5.");
      clean[item.id] = bfi[item.id] === undefined ? null : bfi[item.id];
    }
    const ac = bfi[Castiello.ATTENTION_CHECK.id];
    if (!ok(ac)) throw new ApiError(400, "bad_bfi", "Answers must be whole numbers from 1 to 5.");
    clean[Castiello.ATTENTION_CHECK.id] = ac === undefined ? null : ac;
    return clean;
  }

  async function startSession(uid, { experimentId, participantId }, body) {
    const existing = await store.getSession(experimentId, participantId);
    if (existing) {
      if (existing.uid !== uid) throw new ApiError(403, "not_your_session", "This session does not belong to you.");
      return publicView(existing); // a retried request: same assignment, never re-drawn
    }

    const answers = readBfi(body.bfi);
    const scored = Castiello.scoreBfi(answers);
    const requireAll = config.experiments[experimentId].require_all_items === true;
    if (scored.n_skipped > (requireAll ? 0 : config.max_bfi_skips)) {
      throw new ApiError(400, "too_many_skips", "Too many questionnaire items were left blank.");
    }
    if (requireAll && scored.attention_check_response == null) {
      throw new ApiError(400, "too_many_skips", "Too many questionnaire items were left blank.");
    }
    const profile = profileOf(experimentId);
    let inviteLabel = null;
    if (config.experiments[experimentId].invite_only) {
      const code = typeof body.invite === "string" ? body.invite.trim() : "";
      const used = code && code.length <= 200 ? await store.claimInvite(experimentId, hashInvite(code), uid, now().toISOString()) : null;
      if (!used || !used.ok) throw new ApiError(403, "invite_invalid", "This study link is not valid or has already been used.");
      inviteLabel = used.label || null;
    }
    const prolific = checkProlific(experimentId, body.prolific);
    if (prolific) {
      const max = config.experiments[experimentId].prolific.max_sessions_per_participant || 1;
      const ok = await store.claimProlificSession(experimentId, hashInvite("prolific:" + prolific.pid), max);
      if (!ok) throw new ApiError(429, "too_many_sessions", "This Prolific account has already started the study too many times.");
    }
    const claim = await store.claimSessionSlot(experimentId, uid, config.max_sessions_per_browser,
      config.experiments[experimentId].max_sessions ?? null);
    if (claim === "browser_limit") {
      throw new ApiError(429, "too_many_sessions", "This browser has already started the study too many times.");
    }
    if (claim === "study_full") {
      throw new ApiError(403, "study_full", "This study is not accepting new participants.");
    }

    // Assignment: order x name, simple random (as before). Tests may fix it, but only on a
    // host that explicitly allows it (the local emulator server).
    const force = allowForcedAssignment && body.force && typeof body.force === "object" ? body.force : {};
    const order = ["mirror-first", "inverse-first"].includes(force.order) ? force.order : pick(["mirror-first", "inverse-first"]);
    const mirrorName = ["Pat", "Alex"].includes(force.mirror_name) ? force.mirror_name : pick(["Pat", "Alex"]);
    const inverseName = mirrorName === "Pat" ? "Alex" : "Pat";
    const mirror = scored.traits;
    const inverse = Castiello.inverseProfile(mirror);
    const chats = order === "mirror-first"
      ? [{ condition: "mirror", name: mirrorName, scores: mirror }, { condition: "inverse", name: inverseName, scores: inverse }]
      : [{ condition: "inverse", name: inverseName, scores: inverse }, { condition: "mirror", name: mirrorName, scores: mirror }];

    const session = {
      uid: uid,
      participant_id: participantId,
      experiment_id: experimentId,
      study_phase: config.experiments[experimentId].phase,
      created_at: now().toISOString(),
      bfi_raw: scored.raw,
      bfi_n_skipped: scored.n_skipped,
      bfi_items_answered: scored.items_answered,
      require_all_items: requireAll,
      attention_check_response: scored.attention_check_response,
      attention_check_passed: scored.attention_check_passed,
      traits: mirror,
      mirror_scores: mirror,
      inverse_scores: inverse,
      order: order,
      mirror_name: mirrorName,
      inverse_name: inverseName,
      chat1_name: chats[0].name,
      chat1_condition: chats[0].condition,
      chat2_name: chats[1].name,
      chat2_condition: chats[1].condition,
      // The prompts carry only the five scores and the bot's name, never item answers or ids.
      chat1_prompt: Castiello.PROMPTS[profile.prompt](chats[0].scores, chats[0].name),
      chat2_prompt: Castiello.PROMPTS[profile.prompt](chats[1].scores, chats[1].name),
      opener_trigger: Castiello.OPENER_TRIGGER,
      prompt_version: profile.name,
      safety_version: profile.screen_replies ? Safety.VERSION : null,
      model_safety_settings: profile.safety_settings || null,
      limits: config.limits,
      invite_label: inviteLabel,
      // Only a hash of the Prolific ID (the page's own record keeps the raw ids, exported only to the
      // gitignored identifiers.csv); the study and session ids say which Prolific study it came from.
      prolific_pid_hash: prolific ? hashInvite("prolific:" + prolific.pid) : null,
      prolific_study_id: prolific ? prolific.study_id : null,
      messages_per_chat: config.messages_per_chat,
      max_message_chars: config.max_message_chars,
      model_provider: model.provider,
      model_id: model.model_id,
      model_generation: { ...config.model.generation, ...(profile.generation || {}) },
      chat1_completed_at: null,
      chat2_completed_at: null,
      chat1_safety_stopped_at: null,
      chat2_safety_stopped_at: null,
      n_model_failures: 0,
      n_safety_flags: 0,
    };
    if (!(await store.createSession(experimentId, participantId, session))) {
      return publicView(await store.getSession(experimentId, participantId)); // lost a race with a retry
    }
    return publicView(session);
  }

  // ---- POST /status --------------------------------------------------------------

  async function messageStatus(uid, { experimentId, participantId }, body) {
    const session = await store.getSession(experimentId, participantId);
    if (!session) return { received: false, reply_saved: false };
    if (session.uid !== uid) throw new ApiError(403, "not_your_session", "This session does not belong to you.");
    const chat = body.chat_index;
    const seq = body.seq;
    if ((chat !== 1 && chat !== 2) || !Number.isInteger(seq) || seq < 0 || seq % 2 !== 0) {
      throw new ApiError(400, "bad_seq", "chat_index 1 or 2 and an even seq are needed.");
    }
    const mine = await store.getMessage(experimentId, participantId, chat, seq);
    const reply = await store.getMessage(experimentId, participantId, chat, seq + 1);
    return { received: !!mine, reply_saved: !!reply };
  }

  // ---- POST /end -----------------------------------------------------------------

  // Recorded once; works while paused too, so a participant can always end cleanly.
  async function endSession(uid, { experimentId, participantId }, body) {
    const session = await store.getSession(experimentId, participantId);
    if (!session) return { ok: true };
    if (session.uid !== uid) throw new ApiError(403, "not_your_session", "This session does not belong to you.");
    if (!session.ended_by_participant_at) {
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 40) : null;
      const chat = body.chat_index === 1 || body.chat_index === 2 ? body.chat_index : null;
      await store.updateSession(experimentId, participantId, { ended_by_participant_at: now().toISOString(), ended_reason: reason, ended_in_chat: chat });
      await store.logEvent(experimentId, participantId, { type: "participant_ended", chat_index: chat, reason: reason, at: now().toISOString() });
    }
    return { ok: true };
  }

  // ---- POST /turn ----------------------------------------------------------------

  async function takeTurn(uid, { experimentId, participantId }, body) {
    const session = await store.getSession(experimentId, participantId);
    if (!session) throw new ApiError(404, "no_session", "Start the session before chatting.");
    if (session.uid !== uid) throw new ApiError(403, "not_your_session", "This session does not belong to you.");
    if (session.ended_by_participant_at) throw new ApiError(409, "session_ended", "This session has ended.");

    const chat = body.chat_index;
    const seq = body.seq;
    const total = session.messages_per_chat;
    if (chat !== 1 && chat !== 2) throw new ApiError(400, "bad_chat", "chat_index must be 1 or 2.");
    if (!Number.isInteger(seq) || seq < 0 || seq % 2 !== 0 || seq > total) {
      throw new ApiError(400, "bad_seq", "Participant messages have even numbers from 0 to " + total + ".");
    }
    let text;
    if (seq === 0) {
      text = session.opener_trigger; // the hidden opener request; whatever the browser sent is ignored
    } else {
      text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) throw new ApiError(400, "empty_message", "The message is empty.");
      if (text.length > session.max_message_chars) throw new ApiError(400, "message_too_long", "The message is too long.");
    }
    // A chat stopped by the safety check stays stopped: the same answer again, no model call.
    if (session["chat" + chat + "_safety_stopped_at"]) return { reply: null, done: true, stopped: "safety" };
    // Chats happen in order: the second bot is unavailable until the first chat is finished
    // (or was stopped by the safety check).
    if (chat === 2 && !session.chat1_safety_stopped_at && !(await store.getMessage(experimentId, participantId, 1, total))) {
      throw new ApiError(409, "chat_order", "The first chat is not finished yet.");
    }

    // Record the participant's message exactly once.
    // One read of the history: if an identical request saved this message in the meantime it is
    // found here, and the order checks below only ever see a history without it.
    let mine = await store.getMessage(experimentId, participantId, chat, seq);
    if (!mine) {
      const history = await store.listMessages(experimentId, participantId, chat);
      mine = history.find((m) => m.seq === seq) || null; // an identical request got there first
      if (!mine) {
        const last = history.length ? history[history.length - 1].seq : -1;
        if (last >= 0 && last % 2 === 0) {
          throw new ApiError(409, "awaiting_reply", "Still waiting for the reply to message " + last + ".", { pending_seq: last });
        }
        if (seq !== last + 1) throw new ApiError(409, "out_of_order", "Expected message " + (last + 1) + ".", { expected_seq: last + 1 });
        const msg = {
          chat_index: chat, seq: seq, from: seq === 0 ? "system" : "participant", kind: seq === 0 ? "open" : "message",
          text: text, bot_name: session["chat" + chat + "_name"], received_at: now().toISOString(),
        };
        const created = await store.createMessage(experimentId, participantId, msg);
        mine = created ? msg : await store.getMessage(experimentId, participantId, chat, seq); // a concurrent retry won
      }
    }
    if (seq > 0 && mine.text !== text) {
      throw new ApiError(409, "conflicting_message", "A different message " + seq + " was already sent.");
    }

    if (seq === total) { // the participant has the last word (even totals): no reply
      await store.updateSession(experimentId, participantId, { ["chat" + chat + "_completed_at"]: now().toISOString() });
      return { reply: null, done: true };
    }

    const replySeq = seq + 1;
    const done = replySeq === total;
    const already = await store.getMessage(experimentId, participantId, chat, replySeq);
    if (already) return { reply: { seq: replySeq, text: already.text }, done };

    const reply = await generateReply(session, experimentId, participantId, chat, seq, body.retry === "manual");
    if (reply.ended) throw new ApiError(409, "session_ended", "This session has ended.");
    if (reply.already) {
      if (done) await store.updateSession(experimentId, participantId, { ["chat" + chat + "_completed_at"]: now().toISOString() });
      return { reply: { seq: replySeq, text: reply.already.text }, done };
    }
    if (reply.stopped && reply.by_other) return { reply: null, done: true, stopped: "safety" };
    if (reply.stopped) {
      const at = now().toISOString();
      await store.updateSession(experimentId, participantId, { ["chat" + chat + "_safety_stopped_at"]: at });
      await store.logEvent(experimentId, participantId, {
        type: "safety_stop", chat_index: chat, seq: seq + 1, at: at, reason: reply.reason,
        prompt_version: session.prompt_version || null, safety_version: session.safety_version || null,
      });
      return { reply: null, done: true, stopped: "safety" };
    }
    const created = await store.createMessage(experimentId, participantId, reply);
    const saved = created ? reply : await store.getMessage(experimentId, participantId, chat, replySeq); // a concurrent retry won
    if (done) await store.updateSession(experimentId, participantId, { ["chat" + chat + "_completed_at"]: now().toISOString() });
    return { reply: { seq: replySeq, text: saved.text }, done };
  }

  // The model sees this chat's prompt and this chat's messages only, from the hidden opener
  // request up to the participant's latest message (the full history, as in Experiment 3).
  // No participant id or anything derived from one goes in: retries are counted here.
  // Returns the reply to save, or { stopped: true, reason } when the safety check stops the chat.
  async function generateReply(session, experimentId, participantId, chat, seq, manualRetry) {
    const key = "c" + chat + "-" + String(seq + 1).padStart(3, "0");
    const owner = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let keepLease = false;
    try {
      const out = await makeReply(session, experimentId, participantId, chat, seq, key, owner, manualRetry);
      keepLease = !!(out && out.kind === "reply"); // kept until it lapses: the reply is saved right after
      return out;
    } finally {
      // Without a reply (failure, timeout, stop, exit), the next request may try at once.
      if (!keepLease) await store.releaseLease(experimentId, participantId, key, owner).catch(() => {});
    }
  }

  async function makeReply(session, experimentId, participantId, chat, seq, key, owner, manualRetry) {
    const started = Date.now();
    // The message's deadline: kept by every re-send, renewed only by the participant's "Try again".
    const deadline = config.reply_deadline_ms
      ? await store.replyDeadline(experimentId, participantId, key, started + config.reply_deadline_ms, !!manualRetry)
      : Infinity;
    if (Date.now() >= deadline) {
      // A re-send after this message's deadline: no new call (only "Try again" starts a new one).
      throw new ApiError(503, "reply_timeout", "The reply took too long. Please try again.");
    }
    const history = (await store.listMessages(experimentId, participantId, chat)).filter((m) => m.seq <= seq);
    const request = {
      system: session["chat" + chat + "_prompt"],
      messages: history.map((m) => ({ role: m.from === "bot" ? "model" : "user", text: m.text })),
      generation: session.model_generation,
      safety_settings: session.model_safety_settings || null,
    };
    const screen = !!session.safety_version;
    const limits = session.limits || config.limits;
    const event = (type, fields) => store.logEvent(experimentId, participantId, {
      type, chat_index: chat, seq: seq + 1, at: now().toISOString(),
      model_provider: model.provider, model_id: model.model_id,
      prompt_version: session.prompt_version || null, safety_version: session.safety_version || null, ...fields,
    });
    // One request at a time makes this reply (a lease, held by `owner` until this request's
    // deadline): a repeated or simultaneous request for the same message waits for that request's
    // result instead of calling the model again.
    // The participant left while this reply was being made: nothing more is generated or saved.
    const endedNow = async () => !!((await store.getSession(experimentId, participantId)) || {}).ended_by_participant_at;
    let timedOut = false;
    for (let attempt = 1; attempt <= config.model_attempts; attempt++) {
      await checkNotPaused(experimentId); // a pause set while this request waits stops the next call
      if (await endedNow()) return { ended: true };
      const left = deadline - Date.now();
      if (left < (config.min_attempt_ms || 0)) { timedOut = true; break; }
      const budget = await store.reserveModelCall(experimentId, participantId, key, limits, { owner, until: deadline });
      // Another request for this message is running: wait for its result, until its deadline.
      if (!budget.ok && budget.reason === "in_progress") return waitForOther(experimentId, participantId, chat, seq + 1, Math.min(deadline, budget.until || deadline) + 2000);
      if (!budget.ok) {
        if (budget.flags > 0) return { stopped: true, reason: "budget_after_flag" };
        await event("call_limit", { reason: budget.reason });
        throw new ApiError(503, "reply_unavailable", "The reply could not be generated.", { retryable: false });
      }
      const t0 = Date.now();
      const limit = Math.min(config.attempt_timeout_ms || config.model_timeout_ms, config.model_timeout_ms, left);
      const abort = new AbortController();
      let out;
      try {
        out = await withTimeout(Promise.resolve().then(() => model.generate({ ...request, signal: abort.signal })), limit);
      } catch (e) {
        abort.abort(); // a call past its time is cancelled, so its answer can never arrive later
        if (e && e.code === "timeout") timedOut = true;
        await event("model_failure", { attempt, ms: Date.now() - t0, code: (e && e.code) || "error", message: String((e && e.message) || e).slice(0, 300) });
        // A quick failure (e.g. the provider's 5xx or 429) gets a short pause before the next attempt.
        if (!timedOut && config.retry_backoff_ms) await new Promise((r) => setTimeout(r, Math.min(config.retry_backoff_ms, Math.max(0, deadline - Date.now() - (config.min_attempt_ms || 0)))));
        continue;
      }
      const text = out && typeof out.text === "string" ? out.text.trim() : "";
      const finish = (out && out.finish_reason) || null;
      // The check runs before anything is saved or returned. If it cannot run, the reply is withheld.
      let check = { flagged: false, rules: [], categories: [] };
      if (screen && Safety.PROVIDER_BLOCK.test(finish || "")) {
        check = { flagged: true, rules: ["provider_block"], categories: ["provider_block"] };
      } else if (screen && text) {
        try { check = Safety.screenReply(text); } catch (e) { check = { flagged: true, rules: ["screen_error"], categories: ["screen_error"] }; }
      }
      if (check.flagged) {
        await store.saveWithheld(experimentId, participantId, {
          chat_index: chat, seq: seq + 1, attempt, at: now().toISOString(), text: text, finish_reason: finish,
          rules: check.rules, categories: check.categories, model_id: model.model_id,
          model_version: (out && out.model_version) || null,
          prompt_version: session.prompt_version || null, safety_version: session.safety_version || null,
        });
        const flags = await store.noteFlag(experimentId, participantId, key);
        await store.incrementSession(experimentId, participantId, "n_safety_flags");
        await event("safety_flag", { attempt, ms: Date.now() - t0, rules: check.rules, categories: check.categories, finish_reason: finish, flags_for_reply: flags });
        if (flags >= limits.max_flags_per_reply) return { stopped: true, reason: "flag_limit" };
        continue;
      }
      if (!text) {
        await event("model_failure", { attempt, ms: Date.now() - t0, code: "empty_reply", message: "empty reply (finish reason: " + (finish || "unknown") + ")" });
        continue;
      }
      // Checked, but the participant left meanwhile: kept for review, never saved as shown.
      if (await endedNow()) {
        await store.saveWithheld(experimentId, participantId, {
          chat_index: chat, seq: seq + 1, attempt, at: now().toISOString(), text: text, finish_reason: finish,
          rules: ["after_participant_ended"], categories: ["not_shown"], model_id: model.model_id,
          model_version: (out && out.model_version) || null,
          prompt_version: session.prompt_version || null, safety_version: session.safety_version || null,
        });
        await event("late_reply_discarded", { attempt, ms: Date.now() - t0 });
        return { ended: true };
      }
      return {
        chat_index: chat, seq: seq + 1, from: "bot", kind: "reply", text: text, reply_to_seq: seq,
        bot_name: session["chat" + chat + "_name"], created_at: now().toISOString(),
        latency_ms: Date.now() - t0, total_ms: Date.now() - started, attempts: attempt,
        model_provider: model.provider, model_id: model.model_id,
        model_version: (out && out.model_version) || null, finish_reason: finish,
        // Shown replies say whether they were checked and how many replies were withheld before them.
        safety_version: session.safety_version || null, n_withheld_before: screen ? budget.flags : null,
      };
    }
    await store.incrementSession(experimentId, participantId, "n_model_failures");
    if (timedOut || Date.now() >= deadline) {
      await event("reply_deadline", { ms: Date.now() - started, deadline_ms: config.reply_deadline_ms });
      throw new ApiError(503, "reply_timeout", "The reply took too long. Please try again.");
    }
    throw new ApiError(503, "model_unavailable", "The reply could not be generated. Please try again.");
  }

  // Another request is making this reply: wait (until this request's own deadline) for what it
  // saves: the reply, a safety stop, or the participant ending the session.
  async function waitForOther(experimentId, participantId, chat, replySeq, deadline) {
    while (Date.now() < deadline) {
      const saved = await store.getMessage(experimentId, participantId, chat, replySeq);
      if (saved) return { already: saved };
      const s = (await store.getSession(experimentId, participantId)) || {};
      if (s.ended_by_participant_at) return { ended: true };
      if (s["chat" + chat + "_safety_stopped_at"]) return { stopped: true, by_other: true };
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new ApiError(503, "reply_timeout", "The reply took too long. Please try again.");
  }

  return { handle };
}

module.exports = { createStudyService, ApiError };
