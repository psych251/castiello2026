/*
 * The HTTP side of the chat service: turns a request into core.js's handle() and its answer
 * into a response. Used by the Cloud Function (index.js) and, directly, by the tests.
 *
 *   createHttpHandler({ getService, allowedOrigin, log }) -> async (req, res)
 *
 * getService() builds the study service. If the model is not configured it throws a
 * ModelConfigError, and every request (/health included) gets 503 "model_not_configured", so
 * the participant page stops before consent instead of running without real replies.
 *
 * CORS only decides which pages may call the service from a browser; it is not the access
 * control. Every request is checked against the participant's own sign-in (core.js).
 * Logs show method, path, status and timing, never message text.
 */
"use strict";

function createHttpHandler({ getService, allowedOrigin, log }) {
  const say = log || (() => {});

  return async function handleHttp(req, res) {
    const started = Date.now();
    const origin = req.get ? req.get("origin") : req.headers && req.headers.origin;
    const path = String(req.path || (req.url || "").split("?")[0] || "/");
    res.set("Content-Type", "application/json");
    res.set("Cache-Control", "no-store");
    if (origin && allowedOrigin(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.set("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    let out;
    let service = null;
    try {
      service = getService();
    } catch (e) {
      if (e && e.code === "model_not_configured") {
        say("model not configured: " + e.message);
        out = { status: 503, body: { error: "model_not_configured", message: "The chat service is not set up yet.", retryable: false } };
      } else {
        throw e;
      }
    }
    if (service) {
      const body = req.body;
      out = body !== undefined && body !== null && typeof body !== "object"
        ? { status: 400, body: { error: "bad_json", message: "Request body is not JSON.", retryable: false } }
        : await service.handle({ method: req.method, path: path, authorization: req.get ? req.get("authorization") : req.headers.authorization, body: body || {} });
    }
    res.status(out.status).send(JSON.stringify(out.body));
    say(`${req.method} ${path} ${out.status} ${Date.now() - started}ms`);
  };
}

// Pages the local emulators accept: anything on localhost.
const isLocalOrigin = (o) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o || "");

module.exports = { createHttpHandler, isLocalOrigin };
