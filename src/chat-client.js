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
      this.headers = opts.headers || {}; // test runs only: lets the local emulator skip the suspension
      this.invite = opts.invite || null; // invite-only studies: sent with /access and /session
      this.prolific = opts.prolific || null; // Prolific studies: { pid, study_id, session_id }, same
      // Longer than the service's own deadline for a reply (60 s for all attempts, server/config.js
      // reply_deadline_ms) plus its database work, and shorter than the platform's 120 s, so the
      // page normally hears the service's answer rather than giving up first. If it does give up
      // first, the re-send repeats the same message: the service never answers one message twice,
      // a repeated request waits for the one already making the reply (keeping its deadline),
      // and the call limits bound the calls.
      this.timeoutMs = opts.timeout_ms || 75000;
      this.session = null; // { chats: [{ chat_index, bot_name }], messages_per_chat, max_message_chars }
    }

    /** True if the service answers within a few seconds. */
    async health() {
      if (!this.endpoint) return false;
      try {
        const r = await fetch(this.endpoint + "/health", { headers: this.headers, signal: AbortSignal.timeout(5000) });
        return r.ok;
      } catch (e) {
        return false;
      }
    }

    /**
     * Before signing in: is the study open, and is this invite valid? Sends no sign-in token and
     * writes nothing. Resolves { ok: true } or { ok: false, code }.
     */
    async access() {
      if (!this.endpoint) return { ok: false, code: "not_configured" };
      try {
        const r = await fetch(this.endpoint + "/access", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, this.headers),
          body: JSON.stringify({ experiment_id: this.experimentId, invite: this.invite || undefined, prolific: this.prolific || undefined }),
          signal: AbortSignal.timeout(10000),
        });
        let json = {};
        try { json = await r.json(); } catch (e) { /* not JSON */ }
        return r.ok ? { ok: true } : { ok: false, code: json.error || "http_" + r.status };
      } catch (e) {
        return { ok: false, code: "network" };
      }
    }

    /** Send the BFI answers; the service scores them and assigns the bots. */
    async startSession(bfiAnswers, force) {
      this.session = await this._post("/session", { bfi: bfiAnswers, invite: this.invite || undefined, prolific: this.prolific || undefined, force: force || undefined });
      return this.session;
    }

    /**
     * The participant left: the service makes no further model call for this session and never
     * saves a late reply as shown. Best effort (keepalive, so it survives the page closing).
     */
    end(chatIndex, reason) {
      return this._post("/end", { chat_index: chatIndex, reason: reason }, { keepalive: true }).catch(() => null);
    }

    /**
     * Read only: has the service saved message `seq` (and its reply)? Resolves
     * { received, reply_saved }, or null if it cannot tell within a few seconds.
     */
    status(chatIndex, seq) {
      return this._post("/status", { chat_index: chatIndex, seq: seq }, { timeoutMs: 5000 }).catch(() => null);
    }

    /** One participant message (seq 0 = ask for the opener). Resolves { reply: { seq, text } | null, done }. */
    // retry: undefined (the participant's own send), "auto" (the page's re-send after a dropped
    // connection: keeps the message's deadline) or "manual" ("Try again": a new deadline).
    turn(chatIndex, seq, text, retry) {
      return this._post("/turn", { chat_index: chatIndex, seq: seq, text: text, retry: retry || undefined });
    }

    async _post(path, body, extra) {
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
          headers: Object.assign({ "Content-Type": "application/json", Authorization: "Bearer " + token }, this.headers),
          body: JSON.stringify(Object.assign({ experiment_id: this.experimentId, participant_id: this.saver.docId }, body)),
          signal: AbortSignal.timeout((extra && extra.timeoutMs) || this.timeoutMs),
          keepalive: !!(extra && extra.keepalive),
        });
      } catch (e) {
        const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
        throw new ChatError(0, timedOut ? "timeout" : "network", timedOut ? "The server took too long to answer." : "Could not reach the server.", true);
      }
      let json = {};
      try { json = await r.json(); } catch (e) { /* not JSON */ }
      // The service's own `retryable` decides (e.g. a reply past its call limit is a 503 that must not
      // be retried); only an answer without one falls back to "5xx may be retried".
      const retryable = typeof json.retryable === "boolean" ? json.retryable : r.status >= 500;
      if (!r.ok) throw new ChatError(r.status, json.error || "http_" + r.status, json.message || "Request failed.", retryable);
      return json;
    }
  }

  window.ChatClient = ChatClient;
  window.ChatClient.ChatError = ChatError;
})();
