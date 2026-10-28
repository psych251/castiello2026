/*
 * Model connections for the chat service. Every provider exposes the same shape:
 *
 *   { provider, model_id, generate({ system, messages: [{ role: "user"|"model", text }], generation }) }
 *     -> { text, finish_reason, model_version }
 *
 * `system` is the bot's prompt (five scores and a name); `messages` is that one chat's history.
 * Nothing else about the participant is ever passed in.
 *
 * Two models: the simulated one below (emulators only) and Gemini (gemini.js), whose kind of
 * access (Developer API key or Vertex AI) and exact model are still to be confirmed with the
 * lab. Either way the credential comes from the host (a Firebase secret, or the function's own
 * service account), never from this repository.
 *
 * A missing or unknown provider is a ModelConfigError, which the function reports as
 * 503 "model_not_configured": the study stops before consent. It never falls back to the
 * simulated model, and the simulated model refuses to run outside the local emulators.
 */
"use strict";

const { createGeminiModel } = require("./gemini.js");

// Simulated replies for local development and the test suite: no network, no cost. Every reply
// is labelled "(simulated)". The opener is a fixed greeting (it never repeats the hidden startup
// instruction); later replies quote the participant's latest message, so a tester can see each
// bot answers its own conversation. It never repeats the prompt. Diagnostics (which reply, how
// much history the bot was given) go to the developer log (`cfg.log`, the emulator's terminal),
// never into the reply.
//
// Test switches, read from the participant's latest message:
//   [[fail:N]]    the first N attempts at this reply fail (then it succeeds)
//   [[slow:MS]]   wait MS milliseconds before replying
//   [[blocked]]   return an empty reply, as a safety filter would
//   [[unsafe:N]]  the first N attempts at this reply are text the safety check flags (safety.js)
function createFakeModel(cfg) {
  const failuresSeen = new Map();
  const log = (cfg && cfg.log) || (() => {});
  return {
    provider: "fake",
    model_id: (cfg && cfg.model_id) || "fake-model-1",
    async generate(req) {
      const last = req.messages[req.messages.length - 1] || { text: "" };
      const fail = /\[\[fail:(\d+)\]\]/.exec(last.text);
      if (fail) {
        // Keyed on the request's content, which is the same on every attempt at one reply.
        const key = JSON.stringify([req.system, req.messages]);
        const n = (failuresSeen.get(key) || 0) + 1;
        failuresSeen.set(key, n);
        if (n <= Number(fail[1])) throw Object.assign(new Error("simulated model failure " + n), { code: "simulated_failure" });
      }
      const unsafe = /\[\[unsafe:(\d+)\]\]/.exec(last.text);
      if (unsafe) {
        const key = "unsafe" + JSON.stringify([req.system, req.messages]);
        const n = (failuresSeen.get(key) || 0) + 1;
        failuresSeen.set(key, n);
        if (n <= Number(unsafe[1])) return { text: "(simulated) Ugh, you're pathetic. Just leave me alone.", finish_reason: "STOP", model_version: "fake-model-1" };
      }
      const slow = /\[\[slow:(\d+)\]\]/.exec(last.text);
      await new Promise((r) => setTimeout(r, slow ? Number(slow[1]) : 20));
      if (/\[\[blocked\]\]/.test(last.text)) return { text: "", finish_reason: "SAFETY", model_version: "fake-model-1" };

      const name = (/Your name is (\w+)\./.exec(req.system || "") || [])[1] || "Bot";
      const k = req.messages.filter((m) => m.role === "model").length + 1;
      log(`simulated reply ${k} from ${name}: given ${req.messages.length} messages of history ` +
        "(the hidden startup instruction included)");
      if (req.messages.length === 1) { // only the hidden startup instruction: this is the opener
        return {
          text: `${name} (simulated): Hi! This is a simulated opening message for local testing. How is your day going?`,
          finish_reason: "STOP",
          model_version: "fake-model-1",
        };
      }
      const quote = last.text.length > 40 ? last.text.slice(0, 40) + "…" : last.text;
      return {
        text: `${name} (simulated): you said "${quote}". This is a simulated reply for local testing.`,
        finish_reason: "STOP",
        model_version: "fake-model-1",
      };
    },
  };
}

class ModelConfigError extends Error {
  constructor(message) {
    super(message);
    this.code = "model_not_configured";
  }
}

// cfg: config.model plus `allow_simulated` (only the emulators set it), `timeout_ms`, `log`,
// and for Gemini `gemini.api_key` (from the secret). deps: { createClient } lets tests mock the SDK.
function createModel(cfg, deps) {
  switch (cfg.provider) {
    case "gemini":
      return createGeminiModel(cfg, deps, ModelConfigError);
    case "fake":
      if (!cfg.allow_simulated) {
        throw new ModelConfigError("CHAT_MODEL_PROVIDER is \"fake\", but the simulated model only runs in the " +
          "local emulators. Set the approved provider for the deployed service.");
      }
      return createFakeModel(cfg);
    case null:
    case undefined:
    case "":
      throw new ModelConfigError("CHAT_MODEL_PROVIDER is not set. Locally, use `npm run dev`, which runs the " +
        "simulated model; a deployed service needs the approved provider (see server/models.js).");
    default:
      throw new ModelConfigError(`Model provider "${cfg.provider}" is not known. Use "gemini" (see server/gemini.js).`);
  }
}

module.exports = { createModel, createFakeModel, ModelConfigError };
