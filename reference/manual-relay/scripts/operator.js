#!/usr/bin/env node
/*
 * Operator dashboard for the manual chat relay (Castiello Experiment 3, Pilot A).
 *
 *   npm run operator -- --key <path to your service-account key>        live project
 *   npm run operator -- --emulator                                      local emulator
 *
 * Options: --experiment <id> (default: EXPERIMENT.id in experiment.js), --port <n> (default
 * 8001), --token <t> (default: random). Then open the address it prints, in your own browser.
 *
 * What it does: watches the experiment's participants in Firestore with the Admin SDK. When a
 * participant reaches a chat, it shows you, for each bot (Pat/Alex): its hidden condition, the
 * five scores in its prompt, the full text to paste into a fresh chatbot conversation, the
 * chat so far, and the message waiting for a reply. You paste the chatbot's answer into the
 * box and press Send; it is written to participants/<id>/replies, and the participant's page
 * shows it. Raw BFI answers are never shown or used: the prompt contains only the five scores.
 *
 * The page is served on 127.0.0.1 only (this computer), and every request must carry the
 * random token in the printed address. The service-account key is read by the Admin SDK and
 * never printed or copied. Keep it outside the repository.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const vm = require("vm");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const root = path.join(__dirname, "..");

function defaultExperimentId() {
  const src = fs.readFileSync(path.join(root, "experiment.js"), "utf8");
  const m = src.match(/^\s*id:\s*"([^"]+)"/m);
  return m ? m[1] : null;
}
function configProjectId() {
  try {
    const ctx = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, "firebase-config.js"), "utf8"), ctx);
    return ctx.window.FIREBASE_CONFIG && ctx.window.FIREBASE_CONFIG.projectId;
  } catch (e) {
    return null;
  }
}

const experimentId = arg("experiment", defaultExperimentId());
const emulator = process.argv.includes("--emulator");
const keyPath = arg("key", process.env.GOOGLE_APPLICATION_CREDENTIALS);
const port = Number(arg("port", 8001));
const token = arg("token", crypto.randomBytes(12).toString("hex"));
const TOTAL_MESSAGES = 24;
if (!experimentId) {
  console.error("Could not find EXPERIMENT.id in experiment.js; pass --experiment <id>.");
  process.exit(1);
}

const admin = require("firebase-admin");
if (emulator) {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
  admin.initializeApp({ projectId: "demo-psych251" });
} else {
  if (!keyPath || !fs.existsSync(keyPath)) {
    console.error("No service-account key. Pass --key <path> (or set GOOGLE_APPLICATION_CREDENTIALS).");
    process.exit(1);
  }
  const cred = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  const expected = configProjectId();
  if (expected && cred.project_id !== expected) {
    console.error("This key belongs to a different Firebase project than firebase-config.js (" + expected + "). Stopping.");
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(cred) });
}
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const expRef = db.collection("experiments").doc(experimentId);

// ---------------------------------------------------------------------------
// Firestore state
// ---------------------------------------------------------------------------
const sessions = new Map(); // participant id -> { doc, messages: Map, replies: Map, received: Map, watching }

function iso(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate().toISOString();
  return String(v);
}

function watchSession(id) {
  const s = sessions.get(id);
  if (s.watching) return;
  s.watching = true;
  const ref = expRef.collection("participants").doc(id);
  ref.collection("messages").onSnapshot((snap) => {
    snap.docChanges().forEach((c) => {
      if (c.type === "removed") return;
      if (!s.received.has(c.doc.id)) s.received.set(c.doc.id, new Date().toISOString());
      s.messages.set(c.doc.id, c.doc.data());
    });
  }, (e) => console.error("messages listener:", e.message));
  ref.collection("replies").onSnapshot((snap) => {
    snap.docChanges().forEach((c) => {
      if (c.type !== "removed") s.replies.set(c.doc.id, c.doc.data());
    });
  }, (e) => console.error("replies listener:", e.message));
}

expRef.collection("participants").onSnapshot((snap) => {
  snap.docChanges().forEach((c) => {
    if (c.type === "removed") return sessions.delete(c.doc.id);
    const { full_data, ...doc } = c.doc.data(); // full_data can be large and is not needed here
    if (!sessions.has(c.doc.id)) sessions.set(c.doc.id, { doc, messages: new Map(), replies: new Map(), received: new Map(), watching: false });
    const s = sessions.get(c.doc.id);
    s.doc = doc;
    if (doc.bfi_done) watchSession(c.doc.id);
  });
}, (e) => console.error("participants listener:", e.message));

function botView(s, chatIndex) {
  const d = s.doc;
  const name = d["chat" + chatIndex + "_name"];
  const condition = d["chat" + chatIndex + "_condition"];
  const scores = condition === "mirror" ? d.mirror_scores : d.inverse_scores;
  const prompt = d.bot_prompts ? d.bot_prompts[name] : null;
  const msgs = [...s.messages.entries()].filter(([, m]) => m.chat_index === chatIndex);
  const reps = [...s.replies.values()].filter((r) => r.chat_index === chatIndex);
  const history = [
    ...msgs.filter(([, m]) => m.seq >= 1).map(([, m]) => ({ seq: m.seq, from: "participant", text: m.text })),
    ...reps.map((r) => ({ seq: r.seq, from: "bot", text: r.text })),
  ].sort((a, b) => a.seq - b.seq);
  const answered = new Set(reps.map((r) => r.reply_to_seq));
  const waiting = msgs
    .filter(([, m]) => m.seq < TOTAL_MESSAGES && !answered.has(m.seq))
    .sort((a, b) => b[1].seq - a[1].seq)[0];
  const lastSeq = history.length ? history[history.length - 1].seq : 0;
  return {
    chat_index: chatIndex,
    name, condition, scores,
    prompt,
    first_paste: prompt ? prompt + "\n\n" + (d.opener_trigger || "") : null,
    history,
    messages_so_far: lastSeq,
    finished: lastSeq >= TOTAL_MESSAGES,
    pending: waiting ? { id: waiting[0], seq: waiting[1].seq, kind: waiting[1].kind, text: waiting[1].seq === 0 ? null : waiting[1].text,
                         received_at: s.received.get(waiting[0]) } : null,
  };
}

function stateJson() {
  const list = [...sessions.entries()]
    .filter(([, s]) => s.doc.bfi_done)
    .map(([id, s]) => ({
      participant_id: id,
      started_at: iso(s.doc.started_at) || s.doc.client_started_at || null,
      completed: !!s.doc.completed,
      chat_status: s.doc.chat_status || null,
      relay_service: s.doc.relay_service || null,
      relay_mode: s.doc.relay_mode || null,
      order: s.doc.order || null,
      bots: [botView(s, 1), botView(s, 2)],
    }))
    .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  return { experiment_id: experimentId, mode: emulator ? "emulator" : "live", total_messages: TOTAL_MESSAGES, sessions: list };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function sendReply(body) {
  const s = sessions.get(body.participant_id);
  if (!s) throw new Error("Unknown participant.");
  const chatIndex = Number(body.chat_index);
  const text = String(body.text || "").trim();
  if (!text) throw new Error("The reply is empty.");
  if (!s.doc.relay_service) throw new Error("Enter the model/service you are using for this session first.");
  const view = botView(s, chatIndex);
  if (!view.pending || view.pending.seq !== Number(body.seq)) throw new Error("That message is no longer waiting for a reply.");
  const seq = view.pending.seq + 1;
  const msg = s.messages.get(view.pending.id);
  const id = "c" + chatIndex + "-" + String(seq).padStart(3, "0");
  // create() fails if the reply already exists, so a double click cannot send twice.
  await expRef.collection("participants").doc(body.participant_id).collection("replies").doc(id).create({
    chat_index: chatIndex,
    seq: seq,
    reply_to_seq: view.pending.seq,
    bot_name: view.name,
    bot_condition: view.condition,
    text: text,
    relay_service: s.doc.relay_service,
    request_sent_at: msg && msg.sent_at ? msg.sent_at : null,
    request_received_at: view.pending.received_at || null,
    operator_submitted_at: new Date().toISOString(),
    submitted_at: FieldValue.serverTimestamp(),
  });
  return { ok: true, id };
}

async function setService(body) {
  const s = sessions.get(body.participant_id);
  if (!s) throw new Error("Unknown participant.");
  const service = String(body.relay_service || "").trim();
  if (!service) throw new Error("Enter the model/service name.");
  await expRef.collection("participants").doc(body.participant_id).set(
    { relay_service: service, relay_service_set_at: FieldValue.serverTimestamp() }, { merge: true });
  s.doc.relay_service = service; // show it immediately; the listener will confirm
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP (127.0.0.1 only)
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 100000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); } });
  });
}
function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const t = url.searchParams.get("token") || req.headers["x-token"];
  if (t !== token) {
    res.writeHead(403);
    return res.end("forbidden: open the address printed in the terminal");
  }
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(DASHBOARD_HTML);
    }
    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, stateJson());
    if (req.method === "POST" && url.pathname === "/api/reply") return send(res, 200, await sendReply(await readBody(req)));
    if (req.method === "POST" && url.pathname === "/api/service") return send(res, 200, await setService(await readBody(req)));
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 400, { error: e.message || String(e) });
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log("Operator dashboard for experiments/" + experimentId + " (" + (emulator ? "EMULATOR" : "LIVE project") + ")");
  console.log("Open: http://127.0.0.1:" + port + "/?token=" + token);
  console.log("Leave this window open during the session; press Ctrl+C to stop.");
});

// ---------------------------------------------------------------------------
// The dashboard page
// ---------------------------------------------------------------------------
const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Relay operator</title>
<style>
  body { font: 15px/1.45 system-ui, sans-serif; margin: 0; background: #f4f5f7; color: #111; }
  header { background: #1f3b57; color: #fff; padding: 10px 16px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  header .mode { padding: 2px 8px; border-radius: 4px; font-weight: 600; }
  .mode.live { background: #b3261e; } .mode.emulator { background: #2e7d32; }
  main { padding: 12px 16px; }
  .sessions button { margin: 0 6px 6px 0; }
  .sessions button.sel { outline: 3px solid #1f5f99; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .panel { background: #fff; border: 1px solid #ccd; border-radius: 8px; padding: 12px; }
  .panel.needs { border: 3px solid #d97706; }
  .panel h2 { margin: 0 0 6px; font-size: 18px; }
  .cond { font-size: 12px; padding: 1px 6px; border-radius: 4px; background: #eee; margin-left: 6px; }
  table.scores td { padding: 0 10px 0 0; }
  .hist { max-height: 300px; overflow-y: auto; border: 1px solid #ddd; border-radius: 6px; padding: 6px; background: #fafafa; margin: 8px 0; }
  .m { margin: 4px 0; white-space: pre-wrap; } .m b { display: inline-block; min-width: 92px; color: #555; }
  .pending { background: #fff7e6; border: 1px solid #f0c36d; border-radius: 6px; padding: 8px; margin: 8px 0; white-space: pre-wrap; }
  textarea { width: 100%; box-sizing: border-box; font: inherit; }
  .err { color: #b3261e; } .ok { color: #2e7d32; }
  .svc { background: #fff; border: 1px solid #ccd; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
  details pre { white-space: pre-wrap; background: #f6f6f6; padding: 8px; border-radius: 6px; max-height: 240px; overflow: auto; }
  .help { color: #444; font-size: 14px; }
</style></head>
<body>
<header><strong>Relay operator</strong> <span id="exp"></span> <span id="mode" class="mode"></span> <span id="clock" class="help" style="color:#cde"></span></header>
<main>
  <div class="sessions" id="sessions"></div>
  <div id="session"></div>
</main>
<script>
const TOKEN = new URLSearchParams(location.search).get("token");
let selected = null, lastJson = "", drafts = {};
const $ = (tag, attrs, text) => { const e = document.createElement(tag); Object.assign(e, attrs || {}); if (text !== undefined) e.textContent = text; return e; };
async function api(path, body) {
  const r = await fetch(path + "?token=" + TOKEN, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
}
function copyBtn(label, text) {
  const b = $("button", { type: "button" }, label);
  b.onclick = async () => { await navigator.clipboard.writeText(text); b.textContent = "Copied"; setTimeout(() => (b.textContent = label), 1200); };
  return b;
}
function render(state) {
  document.getElementById("exp").textContent = "experiments/" + state.experiment_id;
  const mode = document.getElementById("mode"); mode.textContent = state.mode === "live" ? "LIVE" : "EMULATOR"; mode.className = "mode " + state.mode;
  const list = document.getElementById("sessions"); list.innerHTML = "";
  if (!state.sessions.length) list.appendChild($("p", { className: "help" }, "No participant has reached the chats yet. Participants appear here once they finish the personality questionnaire."));
  if (!selected || !state.sessions.find((s) => s.participant_id === selected)) {
    const active = state.sessions.find((s) => !s.completed); selected = active ? active.participant_id : (state.sessions[0] || {}).participant_id;
  }
  for (const s of state.sessions) {
    const b = $("button", { type: "button", className: s.participant_id === selected ? "sel" : "" },
      (s.completed ? "✓ " : "● ") + s.participant_id.slice(0, 10) + "… " + (s.chat_status || "") + (s.started_at ? " · " + new Date(s.started_at).toLocaleTimeString() : ""));
    b.onclick = () => { selected = s.participant_id; lastJson = ""; tick(); };
    list.appendChild(b);
  }
  const s = state.sessions.find((x) => x.participant_id === selected);
  const box = document.getElementById("session");
  // keep what you were typing across refreshes
  box.querySelectorAll("textarea[data-key]").forEach((t) => (drafts[t.dataset.key] = t.value));
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
  box.innerHTML = "";
  if (!s) return;
  let needs = false;

  const svc = $("div", { className: "svc" });
  svc.appendChild($("strong", {}, "Model/service used for this session: "));
  const svcIn = $("input", { value: s.relay_service || drafts["svc"] || "", size: 40, placeholder: "e.g. ChatGPT, GPT-4.1 (temporary chat)" });
  svcIn.dataset.key = "svc";
  const svcBtn = $("button", { type: "button" }, s.relay_service ? "Update" : "Save");
  const svcMsg = $("span", { className: "help" }, s.relay_service ? "  saved" : "  required before the first reply");
  svcBtn.onclick = async () => { try { await api("/api/service", { participant_id: s.participant_id, relay_service: svcIn.value }); svcMsg.textContent = "  saved"; lastJson = ""; } catch (e) { svcMsg.textContent = "  " + e.message; svcMsg.className = "err"; } };
  svc.append(svcIn, " ", svcBtn, svcMsg);
  svc.appendChild($("div", { className: "help" }, "Participant " + s.participant_id + " · order: " + s.order + (s.completed ? " · COMPLETED" : "")));
  box.appendChild(svc);

  const row = $("div", { className: "row" });
  for (const bot of s.bots) {
    const p = $("div", { className: "panel" });
    const h = $("h2", {}, "Chat " + bot.chat_index + " · " + bot.name);
    h.appendChild($("span", { className: "cond" }, (bot.condition || "").toUpperCase() + " (hidden from participant)"));
    p.appendChild(h);
    p.appendChild($("div", { className: "help" }, "Messages so far: " + bot.messages_so_far + " of " + state.total_messages + (bot.finished ? " · chat finished" : "")));
    const t = $("table", { className: "scores" });
    for (const k of ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"]) {
      const tr = $("tr"); tr.append($("td", {}, k), $("td", {}, bot.scores && bot.scores[k] != null ? Number(bot.scores[k]).toFixed(2) : "NA")); t.appendChild(tr);
    }
    p.appendChild(t);
    if (bot.first_paste) {
      const d = $("details"); d.appendChild($("summary", {}, "Prompt for " + bot.name + " (scores only)"));
      d.appendChild($("pre", {}, bot.first_paste)); p.appendChild(d);
    }
    const hist = $("div", { className: "hist" });
    if (!bot.history.length) hist.appendChild($("div", { className: "help" }, "No messages yet."));
    for (const m of bot.history) { const line = $("div", { className: "m" }); line.appendChild($("b", {}, m.seq + " " + (m.from === "bot" ? bot.name : "participant"))); line.append(" " + m.text); hist.appendChild(line); }
    p.appendChild(hist);
    setTimeout(() => (hist.scrollTop = hist.scrollHeight), 0);

    if (bot.pending) {
      needs = true; p.className = "panel needs";
      const pend = $("div", { className: "pending" });
      if (bot.pending.seq === 0) {
        pend.appendChild($("div", {}, "STEP 1. Open a NEW, empty chat in your chatbot service (temporary chat, memory and custom instructions off). STEP 2. Paste this whole text as your first message. STEP 3. Paste the chatbot's reply below: it is " + bot.name + "'s opening message."));
        pend.appendChild(copyBtn("Copy opening text for " + bot.name, bot.first_paste));
      } else {
        pend.appendChild($("div", {}, "Participant (message " + bot.pending.seq + "):"));
        pend.appendChild($("div", { style: "font-weight:600;margin:4px 0" }, bot.pending.text));
        pend.appendChild(copyBtn("Copy participant message", bot.pending.text));
        pend.appendChild($("div", { className: "help" }, "Paste it into " + bot.name + "'s chat only, then paste the reply below."));
      }
      p.appendChild(pend);
      const key = s.participant_id + ":" + bot.chat_index + ":" + bot.pending.seq;
      const ta = $("textarea", { rows: 4, placeholder: bot.name + "'s reply" }); ta.dataset.key = key; ta.value = drafts[key] || "";
      const btn = $("button", { type: "button" }, "Send reply to participant (message " + (bot.pending.seq + 1) + ")");
      const msg = $("div", { className: "help" });
      btn.onclick = async () => {
        btn.disabled = true;
        try { await api("/api/reply", { participant_id: s.participant_id, chat_index: bot.chat_index, seq: bot.pending.seq, text: ta.value }); delete drafts[key]; msg.textContent = "Sent."; msg.className = "ok"; lastJson = ""; }
        catch (e) { msg.textContent = e.message; msg.className = "err"; btn.disabled = false; }
      };
      p.append(ta, btn, msg);
    } else if (!bot.finished) {
      p.appendChild($("div", { className: "help" }, bot.messages_so_far === 0 ? "Waiting for the participant to start this chat." : "Waiting for the participant to type."));
    }
    row.appendChild(p);
  }
  box.appendChild(row);
  if (focused) { const el = box.querySelector('[data-key="' + CSS.escape(focused) + '"]'); if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; } }
  document.title = (needs ? "● Reply needed · " : "") + "Relay operator";
}
async function tick() {
  try {
    const state = await api("/api/state");
    const j = JSON.stringify(state);
    document.getElementById("clock").textContent = "updated " + new Date().toLocaleTimeString();
    if (j !== lastJson) { lastJson = j; render(state); }
  } catch (e) { document.getElementById("clock").textContent = "cannot reach the operator script: " + e.message; }
}
tick(); setInterval(tick, 1000);
</script></body></html>`;
