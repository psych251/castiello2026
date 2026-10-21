/*
 * ChatClient: the participant page's side of the chat service (server/core.js).
 *
 * Every request carries the participant's Firebase sign-in token, so the service knows whose
 * session it is. The page sends the questionnaire answers once and then one message at a time;
 * it gets back only the two bot names and the bots' replies, never the condition, the scores or
 * the prompts.
 */
(function () {
  "use strict";

  class ChatError extends Error {
    constructor(status, code, message, retryable) {
      super(message);
      this.status = status;
      this.code = code;
      this.retryable = retryable;
    }
  }

  class ChatClient {
    constructor(opts) {
      this.endpoint = String(opts.endpoint || "").replace(/\/$/, "");
      this.saver = opts.saver;
      this.experimentId = opts.experiment_id;
      // Longer than the Cloud Function's own limit (120 s: two 45-second model attempts plus the
      // database work), so the page only gives up after the server has. Giving up earlier would
      // let "Try again" start a second, parallel model call for the same message.
      this.timeoutMs = opts.timeout_ms || 125000;
      this.session = null; // { chats: [{ chat_index, bot_name }], messages_per_chat, max_message_chars }
    }

    /** True if the service answers within a few seconds. */
    async health() {
      if (!this.endpoint) return false;
      try {
        const r = await fetch(this.endpoint + "/health", { signal: AbortSignal.timeout(5000) });
        return r.ok;
      } catch (e) {
        return false;
      }
    }

    /** Send the BFI answers; the service scores them and assigns the bots. */
    async startSession(bfiAnswers, force) {
      this.session = await this._post("/session", { bfi: bfiAnswers, force: force || undefined });
      return this.session;
    }

    /** One participant message (seq 0 = ask for the opener). Resolves { reply: { seq, text } | null, done }. */
    turn(chatIndex, seq, text) {
      return this._post("/turn", { chat_index: chatIndex, seq: seq, text: text });
    }

    async _post(path, body) {
      let token;
      try {
        token = await this.saver.getIdToken();
      } catch (e) {
        throw new ChatError(0, "no_token", "Not signed in.", true);
      }
      let r;
      try {
        r = await fetch(this.endpoint + path, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify(Object.assign({ experiment_id: this.experimentId, participant_id: this.saver.docId }, body)),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
        throw new ChatError(0, timedOut ? "timeout" : "network", timedOut ? "The server took too long to answer." : "Could not reach the server.", true);
      }
      let json = {};
      try { json = await r.json(); } catch (e) { /* not JSON */ }
      if (!r.ok) throw new ChatError(r.status, json.error || "http_" + r.status, json.message || "Request failed.", !!json.retryable || r.status >= 500);
      return json;
    }
  }

  window.ChatClient = ChatClient;
  window.ChatClient.ChatError = ChatError;
})();
