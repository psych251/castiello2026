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
 *   POST /session  { experiment_id, participant_id, bfi, force? }
 *        Scores the BFI, draws the order and names, builds both prompts and saves them
 *        privately. Returns only the two bot names in chat order.
 *   POST /turn     { experiment_id, participant_id, chat_index, seq, text }
 *        One participant message (seq 0 is the hidden request for the bot's opener). Returns
 *        the bot's reply, { reply: { seq, text }, done }. Safe to repeat: the same message
 *        again returns the same reply instead of a second one.
 *
 * What the browser never receives: the condition labels, the order's meaning, the scores, the
 * prompts, or anything from another participant. Every request is tied to the caller's own
 * sign-in: a participant id must begin with the caller's uid, as in firestore.rules.
 */
"use strict";

const Castiello = require("./castiello.js");

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
  const log = opts.log || (() => {});

  const pick = (xs) => xs[Math.floor(random() * xs.length)];

  // ---- requests --------------------------------------------------------------

  async function handle(req) {
    try {
      if (req.method === "GET" && req.path === "/health") return { status: 200, body: { ok: true } };
      if (req.method !== "POST" || !["/session", "/turn"].includes(req.path)) {
        throw new ApiError(404, "not_found", "No such endpoint.");
      }
      const uid = await authenticate(req.authorization);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const ids = checkIds(body, uid);
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
    if (typeof experimentId !== "string" || !Object.prototype.hasOwnProperty.call(config.experiments, experimentId)) {
      throw new ApiError(403, "unknown_experiment", "This study id does not accept chat sessions.");
    }
    if (typeof participantId !== "string" || !ID_PATTERN.test(participantId) || !participantId.startsWith(uid + "-")) {
      throw new ApiError(403, "not_your_session", "This session does not belong to you.");
    }
    return { experimentId, participantId };
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
    if (scored.n_skipped > config.max_bfi_skips) {
      throw new ApiError(400, "too_many_skips", "Too many questionnaire items were left blank.");
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
      chat1_prompt: Castiello.buildPrompt(chats[0].scores, chats[0].name),
      chat2_prompt: Castiello.buildPrompt(chats[1].scores, chats[1].name),
      opener_trigger: Castiello.OPENER_TRIGGER,
      prompt_version: config.prompt_version,
      messages_per_chat: config.messages_per_chat,
      max_message_chars: config.max_message_chars,
      model_provider: model.provider,
      model_id: model.model_id,
      model_generation: config.model.generation,
      chat1_completed_at: null,
      chat2_completed_at: null,
      n_model_failures: 0,
    };
    if (!(await store.createSession(experimentId, participantId, session))) {
      return publicView(await store.getSession(experimentId, participantId)); // lost a race with a retry
    }
    return publicView(session);
  }

  // ---- POST /turn ----------------------------------------------------------------

  async function takeTurn(uid, { experimentId, participantId }, body) {
    const session = await store.getSession(experimentId, participantId);
    if (!session) throw new ApiError(404, "no_session", "Start the session before chatting.");
    if (session.uid !== uid) throw new ApiError(403, "not_your_session", "This session does not belong to you.");

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
    // Chats happen in order: the second bot is unavailable until the first chat is finished.
    if (chat === 2 && !(await store.getMessage(experimentId, participantId, 1, total))) {
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

    const reply = await generateReply(session, experimentId, participantId, chat, seq);
    const created = await store.createMessage(experimentId, participantId, reply);
    const saved = created ? reply : await store.getMessage(experimentId, participantId, chat, replySeq); // a concurrent retry won
    if (done) await store.updateSession(experimentId, participantId, { ["chat" + chat + "_completed_at"]: now().toISOString() });
    return { reply: { seq: replySeq, text: saved.text }, done };
  }

  // The model sees this chat's prompt and this chat's messages only, from the hidden opener
  // request up to the participant's latest message (the full history, as in Experiment 3).
  // No participant id or anything derived from one goes in: retries are counted here.
  async function generateReply(session, experimentId, participantId, chat, seq) {
    const history = (await store.listMessages(experimentId, participantId, chat)).filter((m) => m.seq <= seq);
    const request = {
      system: session["chat" + chat + "_prompt"],
      messages: history.map((m) => ({ role: m.from === "bot" ? "model" : "user", text: m.text })),
      generation: session.model_generation,
    };
    const started = Date.now();
    for (let attempt = 1; attempt <= config.model_attempts; attempt++) {
      const t0 = Date.now();
      try {
        const out = await withTimeout(Promise.resolve().then(() => model.generate(request)), config.model_timeout_ms);
        const text = out && typeof out.text === "string" ? out.text.trim() : "";
        if (!text) {
          throw Object.assign(new Error("empty reply (finish reason: " + ((out && out.finish_reason) || "unknown") + ")"), { code: "empty_reply" });
        }
        return {
          chat_index: chat, seq: seq + 1, from: "bot", kind: "reply", text: text, reply_to_seq: seq,
          bot_name: session["chat" + chat + "_name"], created_at: now().toISOString(),
          latency_ms: Date.now() - t0, total_ms: Date.now() - started, attempts: attempt,
          model_provider: model.provider, model_id: model.model_id,
          model_version: (out && out.model_version) || null, finish_reason: (out && out.finish_reason) || null,
        };
      } catch (e) {
        await store.logEvent(experimentId, participantId, {
          type: "model_failure", chat_index: chat, seq: seq + 1, attempt: attempt, at: now().toISOString(),
          ms: Date.now() - t0, code: (e && e.code) || "error", message: String((e && e.message) || e).slice(0, 300),
          model_provider: model.provider, model_id: model.model_id,
        });
      }
    }
    await store.incrementSession(experimentId, participantId, "n_model_failures");
    throw new ApiError(503, "model_unavailable", "The reply could not be generated. Please try again.");
  }

  return { handle };
}

module.exports = { createStudyService, ApiError };
