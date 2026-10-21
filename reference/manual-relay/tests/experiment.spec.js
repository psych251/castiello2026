// End-to-end tests: a robot participant runs the Castiello Experiment 3 flow, and a fake
// operator answers its chat messages through the real operator dashboard (scripts/operator.js).
//
// Everything runs against the local Firestore emulator, which `npm test` starts. Without the
// emulator these tests are skipped: this project has a real firebase-config.js, so a run
// outside the emulator would write test records into the live database.
//
// If you change the timeline in experiment.js, update `runThroughExperiment` below so the
// robot still knows which buttons to press.

const { test, expect, devices } = require("@playwright/test");
const { spawn } = require("child_process");
const path = require("path");
const Castiello = require("../src/castiello.js");

const EMULATOR = process.env.EMULATOR === "1" || !!process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-psych251";
const EXPERIMENT_ID = "castiello2026-pilot-a";
const FS = `http://localhost:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const OP_TOKEN = "test-token";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

// The supplement's scoring key, typed out again here (not imported) so the test checks the
// experiment's scoring against an independent copy. Negative = reversed item.
const KEY = {
  openness: [5, 10, 15, 20, 25, 30, -35, 40, -41, 44],
  conscientiousness: [3, -8, 13, -18, -23, 28, 33, 38, -43],
  extraversion: [1, -6, 11, 16, -21, 26, -31, 36],
  agreeableness: [-2, 7, -12, 17, 22, -27, 32, -37, 42],
  neuroticism: [4, -9, 14, 19, -24, 29, -34, 39],
};
const id = (n) => "bfi_" + String(n).padStart(2, "0");

// A varied answer pattern with items 3 and 40 left blank (2 of the 5 allowed skips).
function bfiAnswers(blank = [3, 40]) {
  const a = {};
  for (let n = 1; n <= 44; n++) if (!blank.includes(n)) a[id(n)] = ((n * 7) % 5) + 1;
  a.attention_check = 2; // "Disagree": passes
  return a;
}
function expectedTraits(answers) {
  const out = {};
  for (const [trait, items] of Object.entries(KEY)) {
    const vals = items.map((k) => {
      const v = answers[id(Math.abs(k))];
      return v == null ? null : k < 0 ? 6 - v : v;
    }).filter((v) => v !== null);
    out[trait] = vals.reduce((s, v) => s + v, 0) / vals.length;
  }
  return out;
}

// Post-chat ratings (−2..+2). With chat 1 = mirror, hand-computed affiliation:
//   chat 1: similar 2, enjoy 1, distant −2→+2, understood 1, different −1→+1, again 2 = 9/6 = 1.5
//   chat 2: similar −1, enjoy 0, distant 1→−1, understood −2, different 2→−2, again −1 = −7/6
const AFF = {
  aff_similar: { chat1: 2, chat2: -1 },
  aff_enjoy: { chat1: 1, chat2: 0 },
  aff_distant: { chat1: -2, chat2: 1 },
  aff_understood: { chat1: 1, chat2: -2 },
  aff_different: { chat1: -1, chat2: 2 },
  aff_chat_again: { chat1: 2, chat2: -1 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setSurvey(page, values) {
  await page.waitForFunction((names) => window.__survey && names.every((n) => window.__survey.getQuestionByName(n)), Object.keys(values));
  await page.evaluate((v) => { for (const [k, x] of Object.entries(v)) window.__survey.setValue(k, x); }, values);
}

async function chat(page, chatIndex, total = 24) {
  await page.getByRole("button", { name: "Start chat" }).click();
  for (let k = 1; k <= total / 2; k++) {
    await page.locator(".chat-input:not([disabled])").waitFor({ timeout: 30000 });
    await page.locator(".chat-input").fill(`c${chatIndex}-m${k}`);
    await page.keyboard.press("Enter");
  }
  await expect(page.locator(".chat-end")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
}

async function runThroughExperiment(page, { bfi = bfiAnswers(), aff = AFF, finish = true } = {}) {
  // 1. consent
  await page.getByRole("button", { name: "I agree to participate" }).click();
  // 2. BFI-44
  await setSurvey(page, { bfi: bfi });
  await page.locator('input[value="Continue"]').click();
  // 3. task instructions
  await page.locator("#jspsych-instructions-next").click();
  // 4–5. two chats
  await chat(page, 1);
  await chat(page, 2);
  // 6. post-chat questionnaire
  await setSurvey(page, aff);
  await page.locator('input[value="Continue"]').click();
  // 7. demographics
  await page.locator('input[type="number"]').fill("34");
  await page.getByText("Woman", { exact: true }).click();
  await page.locator('[data-name="native_english"]').getByText("Yes", { exact: true }).first().click();
  await page.locator('input[value="Continue"]').click();
  // 8. debrief
  if (!finish) return;
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByText("All done")).toBeVisible({ timeout: 30000 });
}

async function fsGet(p) {
  // "Bearer owner" is the emulator's admin token: it bypasses security rules, like the Admin SDK.
  const r = await fetch(`${FS}/${p}`, { headers: { Authorization: "Bearer owner" } });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
}
async function fsList(p) {
  const r = await fsGet(`${p}?pageSize=500`);
  return ((r.body && r.body.documents) || []).map((d) => ({ id: d.name.split("/").pop(), ...decodeFields(d.fields) }));
}
function decode(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  return v;
}
function decodeFields(fields) {
  const out = {};
  for (const k of Object.keys(fields || {})) out[k] = decode(fields[k]);
  return out;
}
async function participantDoc(docId) {
  const p = await fsGet(`experiments/${EXPERIMENT_ID}/participants/${docId}`);
  return p.status === 200 ? decodeFields(p.body.fields) : null;
}
async function trialsOf(docId) {
  const chunks = await fsList(`experiments/${EXPERIMENT_ID}/participants/${docId}/trials`);
  return chunks.flatMap((c) => c.trials);
}

// The operator dashboard, one per test worker (each needs its own port).
let operator = null;
let opPort = null;
async function opApi(p, body) {
  const r = await fetch(`http://127.0.0.1:${opPort}${p}?token=${OP_TOKEN}`, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  return { status: r.status, json: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
}

// A fake researcher: polls the dashboard and answers every waiting message for one participant.
function startFakeOperator(participantId) {
  let stop = false;
  const states = [];
  const done = (async () => {
    while (!stop) {
      const { json: state } = await opApi("/api/state");
      const s = state.sessions && state.sessions.find((x) => x.participant_id === participantId);
      if (s) {
        states.push(s);
        if (!s.relay_service) await opApi("/api/service", { participant_id: participantId, relay_service: "fake operator (test)" });
        for (const bot of s.bots) {
          if (!bot.pending) continue;
          const r = await opApi("/api/reply", { participant_id: participantId, chat_index: bot.chat_index, seq: bot.pending.seq,
                                                text: `${bot.name} message ${bot.pending.seq + 1}` });
          if (r.status !== 200 && !/no longer waiting|already exists|relay_service|model\/service/i.test(JSON.stringify(r.json))) {
            throw new Error("operator reply failed: " + JSON.stringify(r.json));
          }
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  })();
  return { states, stop: async () => { stop = true; await done; } };
}

test.beforeEach(() => {
  test.skip(!EMULATOR, "needs the Firestore emulator: run `npm test`");
});

test.beforeAll(async ({}, testInfo) => {
  if (!EMULATOR) return;
  opPort = 8030 + testInfo.workerIndex;
  operator = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "operator.js"), "--emulator",
    "--experiment", EXPERIMENT_ID, "--port", String(opPort), "--token", OP_TOKEN], { stdio: "pipe" });
  for (let i = 0; i < 100; i++) {
    try { if ((await opApi("/api/state")).status === 200) return; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("operator dashboard did not start");
});
test.afterAll(() => { if (operator) operator.kill(); });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("experiment", () => {
  test("a full session with the manual relay saves everything the analysis needs", async ({ page }) => {
    test.setTimeout(240000);
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    await page.goto("/?emulator=1&PROLIFIC_PID=robot123&STUDY_ID=s1&SESSION_ID=sess1&order=mirror-first&mirror_name=Pat");
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    expect(await page.evaluate(() => window.__saver.mode)).toBe("emulator");
    const docId = await page.evaluate(() => window.__saver.docId);

    const op = startFakeOperator(docId);
    const answers = bfiAnswers();
    try {
      await runThroughExperiment(page, { bfi: answers });
    } finally {
      await op.stop();
    }
    expect(pageErrors, "uncaught page errors").toEqual([]);
    const stats = await page.evaluate(() => window.__saver.stats);
    expect(stats.writes_failed).toBe(0);

    // Participant document: assignment, scores, prompts, relay service, completion.
    const p = await participantDoc(docId);
    expect(p.completed).toBe(true);
    expect(p.prolific_pid).toBe("robot123");
    expect(p).toMatchObject({ order: "mirror-first", mirror_name: "Pat", inverse_name: "Alex",
      chat1_name: "Pat", chat1_condition: "mirror", chat2_name: "Alex", chat2_condition: "inverse",
      relay_mode: "manual-relay", relay_service: "fake operator (test)", attention_check_passed: true, bfi_n_skipped: 2 });
    const want = expectedTraits(answers);
    for (const t of Object.keys(KEY)) {
      expect(p.mirror_scores[t]).toBeCloseTo(want[t], 10);
      expect(p.inverse_scores[t]).toBeCloseTo(6 - want[t], 10);
    }
    // Prompts carry the five scores (2 dp) and the bot's name, never item answers.
    expect(p.bot_prompts.Pat).toContain("Openness: " + want.openness.toFixed(2));
    expect(p.bot_prompts.Alex).toContain("Openness: " + (6 - want.openness).toFixed(2));
    expect(p.bot_prompts.Pat).toContain("Your name is Pat.");
    expect(JSON.stringify(p.bot_prompts)).not.toMatch(/bfi_|Is talkative/);

    // Trial rows.
    const trials = await trialsOf(docId);
    expect([...new Set(trials.map((t) => t.participant_id))]).toEqual([docId]);
    const bfi = trials.find((t) => t.task === "bfi");
    expect(bfi.bfi_raw.bfi_03).toBe(null); // a skipped item stays missing, never imputed
    expect(bfi.trait_openness).toBeCloseTo(want.openness, 10);
    expect(bfi.inverse_neuroticism).toBeCloseTo(6 - want.neuroticism, 10);

    const chats = trials.filter((t) => t.task === "chat");
    expect(chats.map((c) => [c.chat_index, c.bot_name, c.bot_condition])).toEqual([[1, "Pat", "mirror"], [2, "Alex", "inverse"]]);
    for (const c of chats) {
      expect(c.n_messages).toBe(24);
      expect(c.n_participant_messages).toBe(12);
      expect(c.n_bot_messages).toBe(12);
      // Hidden opener request (0), then bot on odd numbers and participant on even, in order.
      expect(c.transcript.map((m) => m.seq)).toEqual([...Array(25).keys()]);
      expect(c.transcript[0]).toMatchObject({ from: "system", kind: "open" });
      for (const m of c.transcript.slice(1)) expect(m.from).toBe(m.seq % 2 ? "bot" : "participant");
      // Each chat shows only its own bot's replies and its own participant messages.
      for (const m of c.transcript.filter((x) => x.from === "bot")) expect(m.text).toBe(`${c.bot_name} message ${m.seq}`);
      for (const m of c.transcript.filter((x) => x.from === "participant")) expect(m.text).toMatch(new RegExp(`^c${c.chat_index}-m`));
    }

    const aff = trials.find((t) => t.task === "affiliation");
    expect(aff.affiliation_mirror).toBeCloseTo(1.5, 10);
    expect(aff.affiliation_inverse).toBeCloseTo(-7 / 6, 10);
    expect(aff.affiliation_coded.chat1.distant).toBe(2);
    expect(aff.affiliation_coded.chat2.different).toBe(-2);
    expect(trials.find((t) => t.task === "demographics").response.age).toBe(34);

    // The relay's own records: both sides of both chats, in order, with timing.
    const msgs = await fsList(`experiments/${EXPERIMENT_ID}/participants/${docId}/messages`);
    const reps = await fsList(`experiments/${EXPERIMENT_ID}/participants/${docId}/replies`);
    for (const chatIndex of [1, 2]) {
      expect(msgs.filter((m) => m.chat_index === chatIndex).map((m) => m.seq).sort((a, b) => a - b)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]);
      const r = reps.filter((x) => x.chat_index === chatIndex).sort((a, b) => a.seq - b.seq);
      expect(r.map((x) => x.seq)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]);
      for (const x of r) {
        expect(x.reply_to_seq).toBe(x.seq - 1);
        expect(x.relay_service).toBe("fake operator (test)");
        expect(x.submitted_at && x.request_received_at && x.request_sent_at).toBeTruthy();
      }
    }

    // What the operator saw: chat 2's history never contained chat 1's messages, and the
    // dashboard never exposed raw BFI answers.
    for (const s of op.states) {
      const chat2 = s.bots.find((b) => b.chat_index === 2);
      expect(chat2.history.every((m) => /^c2-m|^Alex /.test(m.text))).toBe(true);
    }
    expect(JSON.stringify(op.states)).not.toMatch(/bfi_\d|Is talkative/);
  });

  test("scoring: BFI keys, inverse profile and affiliation match hand-computed values", async () => {
    // All 5s: openness (8×5 + 2×1)/10 = 4.2; conscientiousness (5×5 + 4×1)/9; extraversion
    // (5×5 + 3×1)/8 = 3.5; agreeableness (5×5 + 4×1)/9; neuroticism (5×5 + 3×1)/8 = 3.5.
    const all5 = {};
    for (let n = 1; n <= 44; n++) all5[id(n)] = 5;
    const s = Castiello.scoreBfi(all5);
    expect(s.traits.openness).toBeCloseTo(4.2, 10);
    expect(s.traits.conscientiousness).toBeCloseTo(29 / 9, 10);
    expect(s.traits.extraversion).toBeCloseTo(3.5, 10);
    expect(s.traits.agreeableness).toBeCloseTo(29 / 9, 10);
    expect(s.traits.neuroticism).toBeCloseTo(3.5, 10);
    expect(s.attention_check_passed).toBe(false); // left blank
    expect(Castiello.inverseProfile(s.traits).openness).toBeCloseTo(1.8, 10);

    // Skips: trait means use only the answered items; nothing is imputed.
    const varied = bfiAnswers([3, 8, 40]);
    const v = Castiello.scoreBfi(varied);
    expect(v.n_skipped).toBe(3);
    expect(v.items_answered.conscientiousness).toBe(7);
    for (const [t, x] of Object.entries(expectedTraits(varied))) expect(v.traits[t]).toBeCloseTo(x, 10);
    expect(v.attention_check_passed).toBe(true);

    // Affiliation: the same ratings scored with chat 1 = inverse swap the two means.
    const a = Castiello.scoreAffiliation(AFF, { chat1: "inverse", chat2: "mirror" });
    expect(a.affiliation_inverse).toBeCloseTo(1.5, 10);
    expect(a.affiliation_mirror).toBeCloseTo(-7 / 6, 10);
    const partial = Castiello.scoreAffiliation({ aff_similar: { chat1: 2 }, aff_distant: { chat1: 2 } }, { chat1: "mirror", chat2: "inverse" });
    expect(partial.affiliation_mirror).toBeCloseTo(0, 10); // (2 + −2) / 2
    expect(partial.affiliation_inverse).toBe(null);
  });

  test("the BFI accepts at most 5 blank items", async ({ page }) => {
    await page.goto("/?emulator=1&standin=1");
    await page.getByRole("button", { name: "I agree to participate" }).click();
    await setSurvey(page, { bfi: bfiAnswers([1, 2, 3, 4, 5, 6]) });
    await page.locator('input[value="Continue"]').click();
    await expect(page.getByText("You have left 6 statements blank")).toBeVisible();
    await expect(page.locator("#jspsych-instructions-next")).toHaveCount(0);

    await setSurvey(page, { bfi: bfiAnswers([1, 2, 3, 4, 5]) });
    await page.locator('input[value="Continue"]').click();
    await expect(page.locator("#jspsych-instructions-next")).toBeVisible();
    const bfi = await page.evaluate(() => window.__saver.allTrials.find((t) => t.task === "bfi"));
    expect(bfi.bfi_n_skipped).toBe(5);
  });

  test("an abandoned chat is never marked complete", async ({ page }) => {
    await page.goto("/?emulator=1");
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    const docId = await page.evaluate(() => window.__saver.docId);
    await page.getByRole("button", { name: "I agree to participate" }).click();
    await setSurvey(page, { bfi: bfiAnswers() });
    await page.locator('input[value="Continue"]').click();
    await page.locator("#jspsych-instructions-next").click();
    await page.getByRole("button", { name: "Start chat" }).click();
    await expect(page.getByText("Waiting for")).toBeVisible();
    await expect.poll(async () => (await fsList(`experiments/${EXPERIMENT_ID}/participants/${docId}/messages`)).length).toBe(1);
    await page.close(); // the participant leaves while waiting for the opener

    const p = await participantDoc(docId);
    expect(p.completed).toBe(false);
    expect(p.chat_status).toBe("chat1");
    const { json: state } = await opApi("/api/state");
    const s = state.sessions.find((x) => x.participant_id === docId);
    expect(s.completed).toBe(false);
    expect(s.bots[0].pending.seq).toBe(0);
  });

  test("the operator dashboard needs its token and shows scores, never item answers", async ({ page }) => {
    const denied = await fetch(`http://127.0.0.1:${opPort}/api/state`);
    expect(denied.status).toBe(403);

    await page.goto("/?emulator=1&standin=1&order=inverse-first&mirror_name=Alex");
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    const docId = await page.evaluate(() => window.__saver.docId);
    await page.getByRole("button", { name: "I agree to participate" }).click();
    await setSurvey(page, { bfi: bfiAnswers() });
    await page.locator('input[value="Continue"]').click();
    await expect(page.locator("#jspsych-instructions-next")).toBeVisible();

    await expect.poll(async () => {
      const { json } = await opApi("/api/state");
      return !!json.sessions.find((x) => x.participant_id === docId);
    }).toBe(true);
    const dash = await page.context().newPage();
    await dash.goto(`http://127.0.0.1:${opPort}/?token=${OP_TOKEN}`);
    await dash.getByRole("button", { name: new RegExp(docId.slice(0, 10)) }).click();
    await expect(dash.getByText("Chat 1 · Pat")).toBeVisible();
    await expect(dash.getByText("INVERSE (hidden from participant)")).toBeVisible();
    await expect(dash.getByText("Chat 2 · Alex")).toBeVisible();
    await expect(dash.locator("body")).not.toContainText("Is talkative");
  });

  test("chunked writes (chunk_size > 1) save every trial, and inverse-first is scored correctly", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto("/?emulator=1&standin=1&chunk_size=4&order=inverse-first&mirror_name=Alex");
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    await runThroughExperiment(page);
    const docId = await page.evaluate(() => window.__saver.docId);
    const p = await participantDoc(docId);
    const chunks = await fsList(`experiments/${EXPERIMENT_ID}/participants/${docId}/trials`);
    expect(chunks.length).toBe(Math.ceil(p.n_trials / 4));
    const trials = chunks.flatMap((d) => d.trials);
    // Every trial saved exactly once. (Indices are not 0..n-1: the skipped "chat unavailable"
    // screen still uses up an index.)
    const indices = trials.map((t) => t.trial_index);
    expect(indices.length).toBe(p.n_trials);
    expect(new Set(indices).size).toBe(p.n_trials);
    expect(p).toMatchObject({ chat1_name: "Pat", chat1_condition: "inverse", chat2_name: "Alex", chat2_condition: "mirror", relay_mode: "standin" });
    const aff = trials.find((t) => t.task === "affiliation");
    expect(aff.affiliation_inverse).toBeCloseTo(1.5, 10); // chat 1 ratings belong to the inverse bot here
    expect(aff.affiliation_mirror).toBeCloseTo(-7 / 6, 10);
  });

  test("declining consent ends the study without a thank-you-for-your-data message", async ({ page }) => {
    await page.goto("/?emulator=1");
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    await page.getByRole("button", { name: "I do not agree" }).click();
    await expect(page.getByText("You chose not to participate")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Your responses were saved")).toHaveCount(0);
    await expect(page.locator(".chat")).toHaveCount(0);
  });

  test("losing the connection at the end offers the download fallback instead of hanging", async ({ page, context }) => {
    test.setTimeout(150000);
    await page.goto("/?emulator=1&standin=1");
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    await runThroughExperiment(page, { finish: false });
    await context.setOffline(true);
    await page.getByRole("button", { name: "Finish" }).click();
    await expect(page.locator("#data-saver-fallback")).toBeVisible({ timeout: 40000 });
    await expect(page.getByText("connection to the server was lost")).toBeVisible();
    await expect(page.getByText("Your responses were saved")).toHaveCount(0);
    await context.setOffline(false);
  });

  test("a second run in the same browser is a new participant and saves cleanly", async ({ page }) => {
    test.setTimeout(180000);
    const ids = [];
    for (let run = 0; run < 2; run++) {
      await page.goto("/?emulator=1&standin=1&PROLIFIC_PID=rerun" + run);
      await page.waitForFunction(() => window.__saver && window.__saver.docId);
      await runThroughExperiment(page);
      const info = await page.evaluate(() => ({ uid: window.__saver.uid, docId: window.__saver.docId, stats: window.__saver.stats }));
      expect(info.stats.writes_failed, "run " + run + " had failed writes").toBe(0);
      ids.push(info);
    }
    expect(ids[0].uid).toBe(ids[1].uid);
    expect(ids[0].docId).not.toBe(ids[1].docId);
    for (let run = 0; run < 2; run++) {
      const p = await participantDoc(ids[run].docId);
      expect(p.completed, "run " + run + " completed").toBe(true);
      expect(p.prolific_pid).toBe("rerun" + run);
      expect((await fsList(`experiments/${EXPERIMENT_ID}/participants/${ids[run].docId}/trials`)).length).toBe(p.n_trials);
    }
  });

  test("setting a Prolific completion code does not break the test run", async ({ page }) => {
    test.setTimeout(120000);
    const navigations = [];
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
    await page.goto("/?emulator=1&standin=1&cc=QA123CODE");
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await runThroughExperiment(page);
    expect(navigations.some((u) => u.includes("prolific.com")), "must not navigate to Prolific").toBe(false);
    await expect(page.getByText("QA123CODE")).toBeVisible();
  });

  test("phones and tablets are turned away before consent", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    await page.goto("http://localhost:8017/?emulator=1");
    await expect(page.locator("#device-unsupported")).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole("button", { name: "I agree to participate" })).toHaveCount(0);
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    const docId = await page.evaluate(() => window.__saver.docId);
    await page.evaluate(() => window.__saver._settle());
    const p = await participantDoc(docId);
    expect(p.device_supported).toBe(false);
    expect(p.completed).toBe(false);
    await context.close();
  });

  test("a desktop browser is not turned away", async ({ page }) => {
    await page.goto("/?emulator=1");
    await expect(page.getByRole("button", { name: "I agree to participate" })).toBeVisible();
    await expect(page.locator("#device-unsupported")).toHaveCount(0);
  });

  test("a write the database refuses is announced on the page, not only in the console", async ({ page }) => {
    await page.goto("/?emulator=1");
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await expect(page.locator('#data-saver-banner[data-kind="offline"]')).toHaveCount(0);
    await page.evaluate(async () => {
      window.__saver.docId = "someone-else-deadbeef";
      await window.__saver.updateParticipant({ blocked: true });
    });
    const banner = page.locator("#data-saver-banner");
    await expect(banner).toHaveAttribute("data-kind", "offline");
    await expect(banner).toContainText("NOT being saved");
    await expect(banner).toContainText("permission-denied");
    await expect(banner).toContainText("2.3");
    expect(await page.evaluate(() => window.__saver.stats.writes_failed)).toBeGreaterThan(0);
  });

  test("the download fallback tells the participant where to send the file", async ({ page }) => {
    await page.goto("/?emulator=1");
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await page.evaluate(() => window.__saver._offerDownload(null, "[]"));
    const box = page.locator("#data-saver-fallback");
    await expect(box).toBeVisible();
    await expect(box).toContainText("@");
    await expect(box).toContainText("you will be paid");
    await expect(box.getByRole("link")).toHaveAttribute("href", /^mailto:/);
  });

  test("security rules: a participant can read only its own replies, and nothing else", async ({ page }) => {
    await page.goto("/?emulator=1");
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    const docId = await page.evaluate(() => window.__saver.docId);

    // The operator (admin) writes one reply to this participant and one to someone else.
    for (const target of [docId, "someone-else-abcd1234"]) {
      const r = await fetch(`${FS}/experiments/${EXPERIMENT_ID}/participants/${target}/replies?documentId=c1-001`, {
        method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { chat_index: { integerValue: "1" }, seq: { integerValue: "1" }, text: { stringValue: "hi from admin" } } }),
      });
      expect(r.status).toBe(200);
    }

    const results = await page.evaluate(async () => {
      const s = window.__saver;
      const fb = s.fb;
      const P = (id, ...rest) => fb.doc(s.db, "experiments", s.opts.experiment_id, "participants", id, ...rest);
      const out = {};
      const attempt = async (name, fn) => {
        try { const v = await fn(); out[name] = v === undefined ? "allowed" : v; } catch (e) { out[name] = e.code || e.message; }
      };
      await attempt("read own reply", async () => (await fb.getDoc(P(s.docId, "replies", "c1-001"))).data().text);
      await attempt("read another participant's reply", () => fb.getDoc(P("someone-else-abcd1234", "replies", "c1-001")));
      await attempt("write own reply", () => fb.setDoc(P(s.docId, "replies", "c1-003"), { text: "forged" }));
      await attempt("create own message (should be allowed)", () => fb.setDoc(P(s.docId, "messages", "c1-002"), { text: "hi" }));
      await attempt("read own message", () => fb.getDoc(P(s.docId, "messages", "c1-002")));
      await attempt("overwrite own message", () => fb.setDoc(P(s.docId, "messages", "c1-002"), { text: "edited" }));
      await attempt("message to another participant", () => fb.setDoc(P("someone-else-abcd1234", "messages", "c1-002"), { text: "x" }));
      await attempt("read own doc", () => fb.getDoc(P(s.docId)));
      await attempt("read own trials", () => fb.getDoc(P(s.docId, "trials", "chunk-00000")));
      await attempt("write other participant", () => fb.setDoc(P("someone-else"), { hacked: true }));
      await attempt("write other participant trials", () => fb.setDoc(P("someone-else", "trials", "c0"), { trials: [] }));
      await attempt("write unrelated collection", () => fb.setDoc(fb.doc(s.db, "spam", "doc"), { spam: true }));
      await attempt("error doc with wrong uid", () =>
        fb.addDoc(fb.collection(s.db, "experiments", s.opts.experiment_id, "errors"), { uid: "not-me", message: "x" }));
      await attempt("own chunk (should be allowed)", () => fb.setDoc(P(s.docId, "trials", "chunk-test"), { trials: [{ a: 1 }] }));
      await attempt("participant doc without the run suffix", () => fb.setDoc(P(s.uid), { sneaky: true }));
      await attempt("another browser's run id", () => fb.setDoc(P("someone-else-abcd1234"), { sneaky: true }));
      return out;
    });

    expect(results["read own reply"]).toBe("hi from admin");
    expect(results["read another participant's reply"]).toBe("permission-denied");
    expect(results["write own reply"]).toBe("permission-denied");
    expect(results["create own message (should be allowed)"]).toBe("allowed");
    expect(results["read own message"]).toBe("permission-denied");
    expect(results["overwrite own message"]).toBe("permission-denied");
    expect(results["message to another participant"]).toBe("permission-denied");
    expect(results["read own doc"]).toBe("permission-denied");
    expect(results["read own trials"]).toBe("permission-denied");
    expect(results["write other participant"]).toBe("permission-denied");
    expect(results["write other participant trials"]).toBe("permission-denied");
    expect(results["write unrelated collection"]).toBe("permission-denied");
    expect(results["error doc with wrong uid"]).toBe("permission-denied");
    expect(results["own chunk (should be allowed)"]).toBe("allowed");
    expect(results["participant doc without the run suffix"]).toBe("permission-denied");
    expect(results["another browser's run id"]).toBe("permission-denied");
  });

  test("uncaught errors are logged to the errors collection", async ({ page }) => {
    await page.goto("/?emulator=1");
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    const uid = await page.evaluate(() => window.__saver.uid);
    await page.evaluate(() => { setTimeout(() => { throw new Error("simulated bug in trial code"); }, 0); });
    await page.waitForFunction(() => window.__saver.stats.errors_logged >= 1);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
    const errs = await fsList(`experiments/${EXPERIMENT_ID}/errors`);
    const mine = errs.filter((d) => d.uid === uid);
    expect(mine.length).toBe(1);
    expect(mine[0].message).toContain("simulated bug");
    expect(mine[0].context.kind).toBe("uncaught");
  });
});
