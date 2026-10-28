/*
 * The Gemini connection for the chat service, built on Google's @google/genai SDK. It returns
 * the same shape as every model in models.js:
 *
 *   { provider, model_id, generate({ system, messages, generation }) -> { text, finish_reason, model_version } }
 *
 * What is settled (and tested with a mocked SDK client, tests/chat-service.spec.js):
 *   - `system` (the bot's prompt) goes as the system instruction; `messages` (that one chat's
 *     history, starting with the hidden startup instruction) go as the contents, in order, with
 *     roles "user" and "model". Nothing else is sent: no ids, no other chat.
 *   - Generation settings left null in config.js are not sent, so the model's defaults apply.
 *   - Safety thresholds are sent only if the study's prompt profile lists them (config.js
 *     prompt_profiles); otherwise none are sent and the provider's defaults apply.
 *   - One SDK request per attempt: the SDK's own retries are turned off, so core.js's
 *     model_attempts and timeout stay the only retry policy and every failure is logged there.
 *   - A blocked or empty answer comes back as empty text with its finish reason; core.js records
 *     it as a failed attempt ("empty_reply") and retries, as it does for the simulated model.
 *   - SDK errors are replaced by a short code and HTTP status before they reach the logs or the
 *     database, so no raw error text (which could echo a request or a key) is stored.
 *   - Logs: model, finish reason, timing and token counts. Never the prompt, messages or key.
 *
 * What waits for the lab's answer (config.js `model.gemini`, set in server/.env.<project id>):
 *   - access "api_key": Gemini Developer API; the key comes from the Firebase secret
 *     GEMINI_API_KEY (index.js), never from a file. Must be a paid-tier key.
 *   - access "vertex": Vertex AI (Gemini Enterprise Agent Platform) in a Google Cloud project,
 *     signed in as the function's own service account (no key); needs vertex_project and
 *     vertex_location, and the "Vertex AI User" role for that account on that project.
 *   - model_id: the exact, pinned model version (not a "-latest" alias).
 * Until all of that is set, createGeminiModel throws a ModelConfigError and the service answers
 * 503 "model_not_configured".
 */
"use strict";

// cfg: { model_id, generation (unused here; sent per request), gemini: { access, api_key,
// vertex_project, vertex_location }, timeout_ms, log }
// deps.createClient(options) -> an object with models.generateContent(); tests pass a mock.
function createGeminiModel(cfg, deps, ModelConfigError) {
  const g = cfg.gemini || {};
  const missing = (what) => new ModelConfigError(`CHAT_MODEL_PROVIDER is "gemini", but ${what}. See server/gemini.js.`);
  if (!cfg.model_id) throw missing("CHAT_MODEL_ID (the exact model version) is not set");

  // ---- the part that depends on the lab's kind of access --------------------------------
  const http = { timeout: cfg.timeout_ms, retryOptions: { attempts: 1 } };
  let options;
  if (g.access === "api_key") {
    if (!g.api_key) throw missing("the GEMINI_API_KEY secret is empty");
    options = { apiKey: g.api_key, httpOptions: http };
  } else if (g.access === "vertex") {
    if (!g.vertex_project || !g.vertex_location) throw missing("CHAT_VERTEX_PROJECT and CHAT_VERTEX_LOCATION are not both set");
    options = { enterprise: true, project: g.vertex_project, location: g.vertex_location, httpOptions: http };
  } else {
    throw missing('CHAT_GEMINI_ACCESS is not "api_key" or "vertex"');
  }
  // ----------------------------------------------------------------------------------------

  const client = (deps && deps.createClient ? deps.createClient : defaultClient)(options);
  const log = cfg.log || (() => {});

  return {
    provider: "gemini",
    model_id: cfg.model_id,
    access: g.access,
    async generate(req) {
      const request = {
        model: cfg.model_id,
        contents: req.messages.map((m) => ({ role: m.role === "model" ? "model" : "user", parts: [{ text: m.text }] })),
        config: { systemInstruction: req.system, ...generationConfig(req.generation),
          // Sent only when the study's profile sets thresholds; otherwise the provider's defaults apply.
          ...(Array.isArray(req.safety_settings) && req.safety_settings.length
            ? { safetySettings: req.safety_settings.map((x) => ({ category: x.category, threshold: x.threshold })) } : {}) },
      };
      // Cancelled when core.js's deadline for this attempt passes, so a late answer is dropped.
      if (req.signal) request.config.abortSignal = req.signal;
      const t0 = Date.now();
      let res;
      try {
        res = await client.models.generateContent(request);
      } catch (e) {
        const status = Number(e && (e.status || e.code)) || null;
        log(`gemini error: ${cfg.model_id} status ${status || "none"} after ${Date.now() - t0}ms`);
        throw Object.assign(new Error("Gemini request failed" + (status ? " (HTTP " + status + ")" : "")),
          { code: status ? "http_" + status : "provider_error" });
      }
      const cand = res && res.candidates && res.candidates[0];
      const blocked = res && res.promptFeedback && res.promptFeedback.blockReason;
      const finish = (cand && cand.finishReason) || (blocked ? "PROMPT_BLOCKED_" + blocked : null);
      const text = (res && typeof res.text === "string" ? res.text : "") || "";
      const u = (res && res.usageMetadata) || {};
      log(`gemini reply: ${cfg.model_id} finish ${finish || "none"} in ${Date.now() - t0}ms, ` +
        `tokens in ${u.promptTokenCount ?? "?"} out ${u.candidatesTokenCount ?? "?"} thinking ${u.thoughtsTokenCount ?? 0}`);
      return { text: text, finish_reason: finish, model_version: (res && res.modelVersion) || cfg.model_id };
    },
  };
}

// config.js names -> the SDK's; null means "the model's default", so it is not sent.
function generationConfig(gen) {
  const out = {};
  if (!gen) return out;
  if (gen.temperature != null) out.temperature = gen.temperature;
  if (gen.top_p != null) out.topP = gen.top_p;
  if (gen.max_output_tokens != null) out.maxOutputTokens = gen.max_output_tokens;
  if (gen.thinking_level != null) out.thinkingConfig = { thinkingLevel: gen.thinking_level };
  return out;
}

function defaultClient(options) {
  const { GoogleGenAI } = require("@google/genai");
  return new GoogleGenAI(options);
}

module.exports = { createGeminiModel, generationConfig };
