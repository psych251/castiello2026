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
  // Only these experiment ids may start chat sessions, so Pilot A and main-study sessions stay
  // apart and a participant cannot invent a new one. Must match EXPERIMENT.id in experiment.js
  // and the ids in writeup/replication-report.qmd. Add the main study's id when it is chosen.
  // max_sessions caps how many chat sessions each study can ever start (a cost guard: anyone
  // can create anonymous sign-ins). Reloads and abandoned runs count too, so leave headroom
  // above the planned sample. null = no cap; 0 = closed (no new sessions; records are kept).
  experiments: {
    // Pilot A (non-naive testers) is finished: closed so no new session can join its data.
    // Its stored records and exports are unaffected.
    "castiello2026-pilot-a": { phase: "pilot-a", max_sessions: 0 },
    // Pilot B (naive Prolific participants): 5 approved, cap twice that, preview session included.
    "castiello2026-pilot-b": { phase: "pilot-b", max_sessions: 10 },
    "castiello2026-phase2": { phase: "phase2", max_sessions: 200 },
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
  max_message_chars: 1000,
  max_bfi_skips: 5,

  // One browser (anonymous uid) may start at most this many sessions per experiment: enough
  // for an honest reload or two, not enough to run up a model bill.
  max_sessions_per_browser: 5,

  // Each participant message gets up to `model_attempts` tries at `model_timeout_ms` each
  // before the participant is shown "Try again".
  model_attempts: 2,
  model_timeout_ms: 45000, // live openers took about 12 s in the first synthetic test (with thinking on)

  // Which prompt text server/castiello.js builds; saved with each session.
  prompt_version: "castiello2026-exp3-supplement-v1",

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
