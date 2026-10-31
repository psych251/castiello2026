/*
 * Settings for the chat service (server/). Nothing here is secret: credentials never live in
 * this file or anywhere in the repository. The model provider is chosen by environment
 * variables, which Firebase reads from files in server/:
 *
 *   server/.env.local          the local emulators only (committed; no secrets): the simulated model
 *   server/.env.<project id>   the deployed function (created at activation; see models.js)
 *
 *   CHAT_MODEL_PROVIDER   "gemini" for the study; "fake" (simulated replies) is refused outside
 *                         the emulators. Unset, unknown or incomplete: the service answers 503
 *                         "model_not_configured" and participants are stopped before consent,
 *                         never given simulated replies.
 *   CHAT_MODEL_ID         the exact, pinned model version, recorded with every session and reply.
 *   CHAT_GEMINI_ACCESS    "api_key" (Gemini Developer API; key in the GEMINI_API_KEY secret) or
 *                         "vertex" (Vertex AI, as the function's service account). To be confirmed.
 *   CHAT_VERTEX_PROJECT, CHAT_VERTEX_LOCATION   Vertex only: the lab's Google Cloud project id and
 *                         region. To be confirmed.
 * server/live.env.example is the template for the deployed settings.
 *
 * Several settings are methodological and still open (see the handoff notes); they are kept
 * here, in one place, so a change is one edit and is recorded with each session.
 */
"use strict";

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

module.exports = {
  // SUSPENSION (2026-10-27; lifted for the Pilot C researcher walkthrough, 2026-10-28, with Pilot
  // A, Pilot B and Phase 2 still closed by `open: false` and Pilot C paused until resumed). While true, the function answers every request (/health, /session and /turn,
  // including turns of sessions that already exist) with 503 "study_suspended" before it checks
  // a sign-in, reads or writes the database, or builds a model client, so nothing reaches Gemini.
  // Stored records, prompts, model settings and billing are untouched. To lift it: set false and
  // redeploy (and restore the caps below). The local emulators honour it too; only the test
  // suite may bypass it there (header X-Test-Ignore-Suspension, refused once deployed).
  suspended: false,

  // Only these experiment ids may start chat sessions, so Pilot A and main-study sessions stay
  // apart and a participant cannot invent a new one. Must match EXPERIMENT.id in experiment.js
  // and the ids in writeup/replication-report.qmd. Add the main study's id when it is chosen.
  //   open           false: every request for the study, turns of existing sessions included, is
  //                  refused (403 "study_closed") before any model call. Records are kept.
  //   max_sessions   how many chat sessions the study can ever start (a cost guard: anyone can
  //                  create anonymous sign-ins). Reloads and abandoned runs count too, so leave
  //                  headroom above the planned sample. null = no cap; 0 = no new sessions.
  //   invite_only    a session needs an invite code (scripts/pilot-admin.js), checked here and,
  //                  before sign-in, by the page (/access). Each code has its own number of uses.
  //   prompt_profile which entry of prompt_profiles below the study's sessions get.
  //   default_paused paused until a researcher resumes it (scripts/pilot-admin.js resume), so a
  //                  fresh deployment never starts taking sessions on its own.
  //   require_all_items  every BFI item and the attention check must be answered (no blank
  //                  allowance); the page also requires all twelve affiliation ratings.
  experiments: {
    // Pilot A (non-naive testers) is finished: closed so no new session can join its data.
    // Its stored records and exports are unaffected.
    "castiello2026-pilot-a": { phase: "pilot-a", open: false, max_sessions: 0, prompt_profile: "castiello2026-exp3-supplement-v1" },
    // Pilot B (naive Prolific participants), 5 approved. Closed 2026-10-27 pending the protocol
    // director's review (was max_sessions: 10, and open). Never reopen it for new testing.
    "castiello2026-pilot-b": { phase: "pilot-b", open: false, max_sessions: 0, prompt_profile: "castiello2026-exp3-supplement-v1" },
    // Pilot C: invited, non-naive testers only, with the revised prompt and safeguards
    // (2026-10-27). Separate from Pilot B; never pooled with it.
    // Closed 2026-10-29 after its researcher (R01) and informed-tester (T01, T02) sessions; records kept.
    "castiello2026-pilot-c": { phase: "pilot-c", open: false, max_sessions: 0, invite_only: true, default_paused: true, prompt_profile: "castiello2026-exp3-safety-v3" },
    // Pilot D: a second naive Prolific pilot (approved 2026-10-29), separate from Pilot C's researcher
    // and tester sessions. Prolific access: a session needs Prolific's PROLIFIC_PID, STUDY_ID and
    // SESSION_ID, STUDY_ID must equal prolific.study_id, and one Prolific ID may start at most
    // prolific.max_sessions_per_participant sessions (a reload). BEFORE LAUNCH set prolific.study_id
    // and max_sessions (e.g. twice the places); until then the deployed service refuses it, and it
    // stays paused until a researcher resumes it.
    // Prolific draft "Pilot D" (duplicated from Pilot B, 2026-10-29): 10 places, so a cap of 20.
    "castiello2026-pilot-d": { phase: "pilot-d", open: true, max_sessions: 20, default_paused: true, prompt_profile: "castiello2026-exp3-safety-v3",
      prolific: { study_id: "6ae2c1c891a6603199aad8fc", max_sessions_per_participant: 2 } },
    // Main replication (50 recruited; planned 2026-10-29, not yet registered or launched). Separate
    // from every pilot. All questionnaire items are required, as in the original study (the
    // authors' confirmation). BEFORE LAUNCH set prolific.study_id and max_sessions; until then
    // the deployed service refuses it, and it stays paused until a researcher resumes it.
    "castiello2026-main": { phase: "main", open: true, max_sessions: 0, default_paused: true, prompt_profile: "castiello2026-exp3-safety-v3",
      require_all_items: true, prolific: { study_id: null, max_sessions_per_participant: 2 } },
    // Closed 2026-10-27 (was max_sessions: 200). Its prompt profile is to be decided.
    "castiello2026-phase2": { phase: "phase2", open: false, max_sessions: 0, prompt_profile: "castiello2026-exp3-safety-v3" },
  },

  // What a study's sessions get: the prompt text (server/castiello.js PROMPTS), whether replies
  // are checked before display (server/safety.js), Gemini's safety thresholds, and generation
  // settings that override `model.generation` below. Each session saves its profile's name,
  // prompt text, check version, thresholds and generation settings.
  //   safety_settings null = not sent, so the provider's defaults apply (an omitted setting, not
  //   a disabled one). A list is sent as Gemini's safetySettings.
  prompt_profiles: {
    // Exactly what Pilot A and Pilot B ran (the paper's prompt; no check; provider defaults).
    "castiello2026-exp3-supplement-v1": { prompt: "v1", screen_replies: false, safety_settings: null },
    // The revised prompt: the paper's text plus boundaries; every reply checked before display;
    // explicit thresholds instead of the provider's defaults.
    "castiello2026-exp3-safety-v2": {
      prompt: "v2",
      screen_replies: true,
      safety_settings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      ],
    },
    // v2 with the researcher's 2026-10-28 decisions: the bot says it is an AI when asked (the
    // paper's "never reveal you are an AI" is removed), ordinary negative emotion is allowed, the
    // same thresholds, and less thinking (Gemini 3.8 Flash supports LOW, MEDIUM (its default) and
    // HIGH), proposed to shorten replies' wait; to be checked against behaviour in a live recheck.
    "castiello2026-exp3-safety-v3": {
      prompt: "v3",
      screen_replies: true,
      safety_settings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      ],
      generation: { thinking_level: "LOW" },
    },
  },

  // Bounds on model calls, whatever the reason (failures, flagged replies, "Try again", repeated
  // requests): a reply that keeps failing or being flagged can never cause unlimited calls.
  //   max_model_calls_per_reply    all attempts at one bot message, across every request for it
  //   max_flags_per_reply          flagged (withheld) replies for one bot message before that chat
  //                                is stopped (participants may go on to the rest of the study)
  //   max_model_calls_per_session  both chats together (24 replies are needed)
  limits: {
    max_model_calls_per_reply: 4,
    max_flags_per_reply: 2,
    max_model_calls_per_session: 60,
  },

  // Each chat ends after this many messages, counting both sides and the bot's opener, as in
  // the current experiment (bot 1, 3, ..., 23; participant 2, 4, ..., 24). With an even number
  // the participant's last message gets no reply; an odd number (e.g. 25) gives the bot the
  // last word. Saved with each session. Not counted here: the hidden startup instruction
  // stored as message 0 of each chat (the request the bot's opener answers), so each chat
  // stores 25 records. Message counts in the data and the turn exclusion leave it out.
  messages_per_chat: 24,

  // Longest participant message, and how many BFI items may be blank (must match
  // EXPERIMENT.max_bfi_skips in experiment.js, which shows the same limit to participants).
  // A study with require_all_items allows none.
  max_message_chars: 1000,
  max_bfi_skips: 5,

  // One browser (anonymous uid) may start at most this many sessions per experiment: enough
  // for an honest reload or two, not enough to run up a model bill.
  max_sessions_per_browser: 5,

  // Each participant message gets up to `model_attempts` tries at `model_timeout_ms` each
  // before the participant is shown "Try again".
  model_attempts: 2,
  model_timeout_ms: 45000, // live openers took about 12 s in the first synthetic test (with thinking on)

  // One deadline for each participant message (2026-10-28), covering every attempt, regeneration
  // and check, instead of a fresh timeout per attempt: in the synthetic Gemini tests one call took
  // 39.5 s. It runs from when the service starts making the reply (reading the chat history) to
  // when it has a checked reply, a stop or gives up; saving the participant's message before it
  // and the reply after it, the network and the page are outside it. An attempt gets at most
  // attempt_timeout_ms and never more than what is left; no new attempt starts with less than
  // min_attempt_ms left. An attempt past its time is cancelled (its late answer is never saved or
  // shown) and the participant sees that the reply took too long, with "Try again" (a new
  // deadline, still within limits.max_model_calls_per_reply). A shorter deadline means fewer long
  // waits but more interrupted replies.
  // 2026-10-28, after the researcher walkthrough (R01): with 9 s per attempt, 9 calls were cancelled
  // and 4 messages needed "Try again" (no filter or provider block involved). Now the first attempt
  // may use the whole deadline; a second attempt runs only if the first fails or is withheld early,
  // and only within what is left of the same deadline.
  // 2026-10-28, after tester T01 (8 cancelled calls at 20 s, no other failure): a slow but working
  // call is left to finish. The deadline belongs to the MESSAGE, not to a request: a re-send of the
  // same message (the page's automatic re-send after a dropped connection) keeps it, and only the
  // participant's own "Try again" starts a new one. Aligned limits, shortest first:
  //   one model call 45 s (= model_timeout_ms, also the SDK's own timeout) < message 60 s
  //   < the page's wait for the service 75 s (src/chat-client.js) < the platform's 120 s
  //   (hosting.timeout_seconds), leaving time for the database and the network.
  // A second attempt follows only a quick failure (after retry_backoff_ms) or a withheld reply,
  // and only if at least min_attempt_ms of the message's deadline is left.
  reply_deadline_ms: 60000,
  attempt_timeout_ms: 45000,
  min_attempt_ms: 10000,
  retry_backoff_ms: 1000,

  // The deployed Cloud Function (index.js). allowed_origins are the pages that may call it from a
  // browser (the GitHub Pages site); the emulators accept localhost instead. max_instances caps
  // how many copies run at once (a cost guard); timeout_seconds covers model_attempts x
  // model_timeout_ms plus the database work.
  hosting: {
    region: "us-central1",
    allowed_origins: ["https://psych251.github.io"],
    max_instances: 10,
    timeout_seconds: 120, // 2 attempts x 45 s, plus the database work
    memory: "256MiB",
  },

  model: {
    provider: env("CHAT_MODEL_PROVIDER", null),
    model_id: env("CHAT_MODEL_ID", null),
    gemini: {
      access: env("CHAT_GEMINI_ACCESS", null),
      vertex_project: env("CHAT_VERTEX_PROJECT", null),
      vertex_location: env("CHAT_VERTEX_LOCATION", null),
    },
    // null = the provider's default. Identical for both bots; recorded with every session.
    generation: {
      temperature: null,
      top_p: null,
      max_output_tokens: null,
    },
  },
};
