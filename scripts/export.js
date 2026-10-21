#!/usr/bin/env node
/*
 * Export Firestore data to tidy CSV (plus a raw JSON dump).
 *
 *   npm run export -- --experiment castiello2026-pilot-a
 *   npm run export -- --experiment castiello2026-pilot-a --key ~/keys/my-project-service-account.json --out data/raw
 *
 * Authentication: the Admin SDK needs a service-account key for YOUR project.
 *   Firebase console -> Project settings -> Service accounts -> "Generate new private key".
 * Save it OUTSIDE the repo (or at a gitignored path; *service-account*.json is ignored) and
 * pass --key, or set GOOGLE_APPLICATION_CREDENTIALS to its path.
 * The key bypasses security rules and can read/delete everything. Never commit it.
 *
 * Or, without a key, your own Google login (Application Default Credentials), naming the
 * project explicitly:
 *   CLOUDSDK_CONFIG=~/.config/gcloud-castiello-export gcloud auth application-default login
 *   CLOUDSDK_CONFIG=~/.config/gcloud-castiello-export npm run export -- --experiment <id> --adc --project <firebase project id>
 * The account needs read access to the project's Firestore. The export only reads Firestore.
 *
 * Output (in --out, default data/raw/<experiment>/):
 *   participants.csv   one row per participant (start/end, completed, condition, browser, ...)
 *   trials.csv         one row per jsPsych trial, long format; nested values are JSON strings
 *   errors.csv         client-side error reports
 *   export.json        the above, verbatim, for safekeeping
 *   identifiers.csv    participant_id -> Prolific ids and raw URL parameters. GITIGNORED.
 *                      Prolific ids are persistent identifiers; keep this file private and
 *                      use it only to approve/pay participants or reconcile duplicates.
 *   messages.csv       one row per chat message, both sides, with timing, model and length
 *                      but NOT the text. Safe to commit. Each chat has 25 rows: the hidden
 *                      startup instruction (seq 0, from "system", kind "open"), which the
 *                      participant never sees and the model answers with the bot's opener,
 *                      then the 24 visible messages (seq 1-24). Message counts
 *                      (chat*_n_messages, server_n_messages) leave seq 0 out; filter
 *                      from != "system" when counting from this file.
 *   chat_events.csv    failed or empty model replies (no message text). Safe to commit.
 *   transcripts.csv    the messages WITH the text, from the chat service's own records (so it
 *                      includes chats that were abandoned). GITIGNORED: participants may type
 *                      anything, including identifying details.
 *
 * The chat service keeps each participant's assignment, scores and prompts where browsers
 * cannot read them (participants/<id>/private/session). This script joins them back on, so
 * the columns the analysis uses are where they always were: order and the bot conditions in
 * participants.csv, trait_* on the BFI row, bot_condition on each chat row, and
 * affiliation_mirror / affiliation_inverse on the affiliation row. The prompts themselves are
 * not exported (they are rebuilt from the scores by server/castiello.js).
 */
const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const experimentId = arg("experiment", null);
const emulator = process.argv.includes("--emulator");
const adc = process.argv.includes("--adc");
const projectId = arg("project", null);
// In --adc mode GOOGLE_APPLICATION_CREDENTIALS is left to Google's own credential lookup, never
// read here as a service-account key.
const keyPath = arg("key", adc ? null : process.env.GOOGLE_APPLICATION_CREDENTIALS);
function usage(problem) {
  if (problem) console.error(problem);
  console.error("Usage: npm run export -- --experiment <id> [--key <service-account.json> | --adc --project <firebase project id> | --emulator] [--out <dir>]");
  process.exit(1);
}
if (!experimentId) usage();
if (adc && emulator) usage("--adc and --emulator cannot be combined.");
if (adc && process.argv.includes("--key")) usage("--adc and --key cannot be combined.");
if (adc && !projectId) usage("--adc needs --project <firebase project id>, so the export never reads a project picked up from the environment.");
if (!adc && process.argv.includes("--project")) usage("--project is only used with --adc (a key names its own project).");
const outDir = arg("out", path.join("data", "raw", experimentId));

const admin = require("firebase-admin");
if (emulator) {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
  admin.initializeApp({ projectId: "demo-psych251" });
} else if (adc) {
  // Application Default Credentials: your own Google login, from
  //   CLOUDSDK_CONFIG=<dir> gcloud auth application-default login
  // The Firestore client's bundled auth library ignores CLOUDSDK_CONFIG and would fall back to
  // ~/.config/gcloud, so a credentials file in CLOUDSDK_CONFIG is named to it explicitly.
  // Only the file's location is printed, never its contents.
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.CLOUDSDK_CONFIG) {
    const file = path.join(process.env.CLOUDSDK_CONFIG, "application_default_credentials.json");
    if (!fs.existsSync(file)) {
      console.error("No credentials in CLOUDSDK_CONFIG (" + process.env.CLOUDSDK_CONFIG + "). Run: gcloud auth application-default login");
      process.exit(1);
    }
    process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
  }
  console.error("Credentials: application default (" + (process.env.GOOGLE_APPLICATION_CREDENTIALS || "gcloud's default location") + "); project: " + projectId);
  if (process.env.FIRESTORE_EMULATOR_HOST) console.error("FIRESTORE_EMULATOR_HOST is set: reading the emulator at " + process.env.FIRESTORE_EMULATOR_HOST + ", not the live project.");
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId });
} else {
  if (!keyPath || !fs.existsSync(keyPath)) {
    console.error("No service-account key. Pass --key <path> or set GOOGLE_APPLICATION_CREDENTIALS.");
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(keyPath, "utf8"))) });
}
const db = admin.firestore();

function plain(v) {
  // Firestore Timestamps -> ISO strings; everything else as-is.
  if (v && typeof v.toDate === "function") return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = plain(v[k]);
    return o;
  }
  return v;
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCsv(file, rows, firstColumns) {
  const cols = [...(firstColumns || [])];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  fs.writeFileSync(file, lines.join("\n") + "\n");
  console.log(`  ${path.relative(process.cwd(), file)}: ${rows.length} rows`);
}

(async () => {
  const expRef = db.collection("experiments").doc(experimentId);
  const participantsSnap = await expRef.collection("participants").get();
  if (participantsSnap.empty) {
    console.error(`No participants found under experiments/${experimentId}. Check the experiment id (EXPERIMENT.id in experiment.js).`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const participants = [];
  const identifiers = [];
  const trials = [];
  const transcripts = [];
  const chatEvents = [];
  const dump = { experiment_id: experimentId, exported_at: new Date().toISOString(), participants: [] };

  for (const pDoc of participantsSnap.docs) {
    const p = plain(pDoc.data());
    const uid = pDoc.id;
    const chunksSnap = await pDoc.ref.collection("trials").orderBy("chunk_index").get();
    const chunks = chunksSnap.docs.map((c) => plain(c.data()));
    let pTrials = chunks.flatMap((c) => c.trials || []);
    let source = "chunks";
    if (pTrials.length === 0 && typeof p.full_data === "string") {
      // No chunk writes reached the server (e.g. quota or network), but the final document did.
      pTrials = JSON.parse(p.full_data);
      source = "full_data";
    } else if (typeof p.full_data === "string") {
      const n = JSON.parse(p.full_data).length;
      if (n !== pTrials.length) console.warn(`  warning: ${uid}: ${pTrials.length} trials in chunks but ${n} in full_data (using chunks)`);
    }
    pTrials.sort((a, b) => (a.trial_index ?? 0) - (b.trial_index ?? 0));

    // Identifiers go to a separate, gitignored file; everything committed stays anonymous.
    const { full_data, prolific_pid, prolific_study_id, prolific_session_id, url_params, ...rest } = p;
    identifiers.push({ participant_id: uid, prolific_pid, prolific_study_id, prolific_session_id,
      url_params, started_at: rest.started_at, completed: rest.completed });
    // The chat service's private records. They win over any same-named field on the
    // participant document, which the participant's own browser is allowed to write.
    const sessSnap = await pDoc.ref.collection("private").doc("session").get();
    const sess = sessSnap.exists ? plain(sessSnap.data()) : null;
    const chatSnap = await pDoc.ref.collection("chat").get();
    const chatMsgs = chatSnap.docs.map((d) => plain(d.data())).sort((a, b) => a.chat_index - b.chat_index || a.seq - b.seq);
    const eventSnap = await pDoc.ref.collection("chat_events").get();
    for (const d of eventSnap.docs) chatEvents.push({ participant_id: uid, event_id: d.id, ...plain(d.data()) });

    const conditionOf = (chat) => (sess ? sess["chat" + chat + "_condition"] : null);
    const shown = (chat) => chatMsgs.filter((m) => m.chat_index === chat && m.seq >= 1).length;
    const sessionFields = sess ? {
      order: sess.order, mirror_name: sess.mirror_name, inverse_name: sess.inverse_name,
      chat1_name: sess.chat1_name, chat1_condition: sess.chat1_condition,
      chat2_name: sess.chat2_name, chat2_condition: sess.chat2_condition,
      study_phase: sess.study_phase, session_created_at: sess.created_at,
      traits: sess.traits, mirror_scores: sess.mirror_scores, inverse_scores: sess.inverse_scores,
      attention_check_passed: sess.attention_check_passed, bfi_n_skipped: sess.bfi_n_skipped,
      messages_per_chat: sess.messages_per_chat, prompt_version: sess.prompt_version,
      model_provider: sess.model_provider, model_id: sess.model_id, model_generation: sess.model_generation,
      chat1_n_messages: shown(1), chat2_n_messages: shown(2),
      chat1_complete: !!sess.chat1_completed_at, chat2_complete: !!sess.chat2_completed_at,
      n_model_failures: sess.n_model_failures || 0,
    } : { chat1_complete: false, chat2_complete: false };
    if (rest.completed && !(sessionFields.chat1_complete && sessionFields.chat2_complete)) {
      console.warn(`  warning: ${uid}: marked completed, but the chat service does not show both chats finished`);
    }
    for (const m of chatMsgs) {
      transcripts.push({
        participant_id: uid, chat_index: m.chat_index, bot_name: m.bot_name, bot_condition: conditionOf(m.chat_index),
        seq: m.seq, from: m.from, kind: m.kind, text: m.text, reply_to_seq: m.reply_to_seq,
        received_at: m.received_at, created_at: m.created_at, latency_ms: m.latency_ms, total_ms: m.total_ms,
        attempts: m.attempts, model_provider: m.model_provider, model_id: m.model_id,
        model_version: m.model_version, finish_reason: m.finish_reason,
      });
    }

    // participant_id comes from the document path, never from the trial row: if an
    // experiment sets its own participant_id the two must not disagree, or trials.csv
    // and participants.csv will not join. Analysis columns from the service are added to the
    // rows they belong on.
    const pubTrials = pTrials.map(({ prolific_pid, participant_id, transcript, ...t }) => {
      if (!sess) return t;
      if (t.task === "bfi") {
        Object.assign(t, { attention_check_passed: sess.attention_check_passed, bfi_n_skipped: sess.bfi_n_skipped,
          bfi_items_answered: sess.bfi_items_answered });
        for (const k of Object.keys(sess.mirror_scores || {})) {
          t["trait_" + k] = sess.mirror_scores[k];
          t["inverse_" + k] = sess.inverse_scores[k];
        }
      }
      if (t.task === "chat" || t.task === "chat_intro") t.bot_condition = conditionOf(t.chat_index);
      if (t.task === "chat") t.server_n_messages = shown(t.chat_index);
      if (t.task === "affiliation") {
        for (const chat of [1, 2]) t["affiliation_" + conditionOf(chat)] = t["affiliation_chat" + chat] ?? null;
      }
      return t;
    });
    participants.push({ participant_id: uid, ...rest, ...sessionFields, n_trials_exported: pubTrials.length, trials_source: source });
    for (const t of pubTrials) trials.push({ participant_id: uid, ...t });
    dump.participants.push({ participant_id: uid, participant: { ...rest, ...sessionFields }, trials: pubTrials, n_chunks: chunks.length,
      chat_messages: transcripts.filter((m) => m.participant_id === uid).map(({ text, ...m }) => ({ ...m, n_chars: String(text || "").length })) });
  }

  const errorsSnap = await expRef.collection("errors").orderBy("at").get().catch(() => expRef.collection("errors").get());
  const errors = errorsSnap.docs.map((d) => {
    const e = plain(d.data());
    if (typeof e.url === "string") e.url = e.url.split("?")[0]; // drop query string (may hold Prolific ids)
    return { error_id: d.id, ...e };
  });
  dump.errors = errors;
  dump.chat_events = chatEvents;

  console.log(`Exported experiments/${experimentId}:`);
  writeCsv(path.join(outDir, "participants.csv"), participants,
    ["participant_id", "completed", "condition", "started_at", "ended_at", "n_trials"]);
  writeCsv(path.join(outDir, "trials.csv"), trials,
    ["participant_id", "trial_index", "task", "condition", "trial_type", "rt", "response", "time_elapsed"]);
  writeCsv(path.join(outDir, "errors.csv"), errors, ["error_id", "uid", "at", "message", "trial_index"]);
  const chatCols = ["participant_id", "chat_index", "bot_name", "bot_condition", "seq", "from", "kind"];
  writeCsv(path.join(outDir, "messages.csv"), transcripts.map(({ text, ...m }) => ({ ...m, n_chars: String(text || "").length })), chatCols);
  writeCsv(path.join(outDir, "chat_events.csv"), chatEvents, ["participant_id", "event_id", "type", "chat_index", "seq", "attempt", "at", "code"]);
  writeCsv(path.join(outDir, "transcripts.csv"), transcripts, [...chatCols, "text"]);
  console.log("  transcripts.csv is gitignored: it holds what participants typed. Keep it private.");
  fs.writeFileSync(path.join(outDir, "export.json"), JSON.stringify(dump, null, 2));
  console.log(`  ${path.relative(process.cwd(), path.join(outDir, "export.json"))}`);
  writeCsv(path.join(outDir, "identifiers.csv"), identifiers, ["participant_id", "prolific_pid", "prolific_study_id", "prolific_session_id"]);
  console.log("  identifiers.csv is gitignored: it links participant ids to Prolific ids. Keep it private.");
  const done = participants.filter((p) => p.completed).length;
  console.log(`${participants.length} participants (${done} completed), ${trials.length} trials, ${errors.length} error reports.`);
  process.exit(0);
})().catch((e) => {
  console.error("Export failed:", e.message || e);
  process.exit(1);
});
