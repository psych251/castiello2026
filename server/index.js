/*
 * The chat service as a Cloud Function (2nd gen, HTTP): server/ is the functions source in
 * firebase.json. The participant page (GitHub Pages) calls it at EXPERIMENT.chat_endpoint:
 *
 *   https://<region>-<project id>.cloudfunctions.net/chat/health | /session | /turn
 *
 * The study logic is core.js; this file only wires it to Firebase. The function signs in to
 * Firestore and Auth as the project's own service account (no key file), so the private records
 * stay where browsers cannot read them (see firestore.rules).
 *
 * In the local emulators (`npm run dev`, `npm test`) the same function runs at
 * http://127.0.0.1:5001/demo-psych251/us-central1/chat, talks to the emulated Firestore and
 * Auth, may use the simulated model (server/.env.local), accepts localhost pages, and lets tests
 * fix the assignment. None of that is possible once deployed: outside the emulators the
 * simulated model and forced assignments are refused, and only allowed_origins may call it.
 */
"use strict";

const { onRequest } = require("firebase-functions/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const config = require("./config.js");
const { createStudyService } = require("./core.js");
const { createFirestoreStore } = require("./store-firestore.js");
const { createModel } = require("./models.js");
const { createHttpHandler, isLocalOrigin } = require("./http.js");

const IN_EMULATOR = process.env.FUNCTIONS_EMULATOR === "true";

// The Gemini Developer API key lives in Firebase's secret store (set with
// `firebase functions:secrets:set GEMINI_API_KEY`). It is only declared when that kind of access
// is chosen: `firebase deploy` checks every declared secret in Secret Manager, so with Vertex AI
// (no key at all) declaring it would make the deploy look for a secret that does not exist.
const USES_API_KEY = config.model.provider === "gemini" && config.model.gemini.access === "api_key";
const GEMINI_API_KEY = USES_API_KEY ? defineSecret("GEMINI_API_KEY") : null;

let service = null;
function getService() {
  if (service) return service;
  // Throws ModelConfigError (-> 503 "model_not_configured") until a model is configured; checked
  // again on the next request, so a fixed configuration takes effect without code changes.
  const model = createModel({
    ...config.model,
    gemini: { ...config.model.gemini, api_key: USES_API_KEY ? GEMINI_API_KEY.value() : null },
    allow_simulated: IN_EMULATOR,
    timeout_ms: config.model_timeout_ms,
    log: (m) => logger.info("chat service: " + m),
  });
  if (!getApps().length) initializeApp();
  service = createStudyService({
    store: createFirestoreStore(getFirestore(), FieldValue),
    model: model,
    config: config,
    verifyToken: (token) => getAuth().verifyIdToken(token),
    allowForcedAssignment: IN_EMULATOR, // tests fix the order and names with ?order=&mirror_name=
    allowUnconfiguredProlific: IN_EMULATOR, // tests run a Prolific study before its study_id is set
    log: (m) => logger.error("chat service: " + m),
  });
  return service;
}

exports.chat = onRequest(
  {
    region: config.hosting.region,
    maxInstances: config.hosting.max_instances,
    timeoutSeconds: config.hosting.timeout_seconds,
    memory: config.hosting.memory,
    invoker: "public", // participants are anonymous; core.js checks every request's sign-in
    secrets: USES_API_KEY ? [GEMINI_API_KEY] : [],
    cors: false, // handled in http.js, so the emulators and the deployed function behave alike
  },
  createHttpHandler({
    getService: getService,
    allowedOrigin: (o) => (IN_EMULATOR ? isLocalOrigin(o) : config.hosting.allowed_origins.includes(o)),
    log: (m) => logger.info("chat service: " + m),
    // config.suspended refuses everything; only the test suite, in the emulators, may skip it.
    isSuspended: (req) => config.suspended &&
      !(IN_EMULATOR && (req.get ? req.get("x-test-ignore-suspension") : req.headers["x-test-ignore-suspension"]) === "1"),
  }),
);
