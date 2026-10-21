# Psych 251 experiment template

A jsPsych 8 web experiment served from GitHub Pages, saving data to the student's own
Firebase (Firestore) project. Read `docs/student-guide.md` for the human workflow and the
skills in `.claude/skills/` for the detailed procedures.

## Layout
- `index.html` loads vendored libraries from `lib/` and runs `experiment.js`. No build step.
- `experiment.js` is the timeline. Settings live in the `EXPERIMENT` object at the top.
- `src/save.js` (`DataSaver`) handles anonymous auth, chunked trial writes, error logging,
  and an offline fallback. Do not bypass it with ad-hoc Firestore calls.
  Each page load gets its own participant document, named `<auth uid>-<run id>`, so a
  reload or a second run never overwrites an earlier one. Use `saver.docId` (not
  `saver.uid`) wherever a participant id is needed, including
  `jsPsych.data.addProperties`, or trials will not join to participants on export.
- `firebase-config.js` is the pasted web-app config. It is public by design.
- `server/` is the chat service, deployed as one Cloud Function (`firebase.json` "functions"
  source; its own `package.json` and `node_modules`): `index.js` (the function), `http.js`
  (CORS, errors), `core.js` (BFI scoring, mirror/inverse assignment, prompts, turn order,
  retries, usage limits), `models.js` (picks the model: the simulated one, emulators only, or
  Gemini; an unset, unknown or incomplete provider is a 503 "model_not_configured", never
  simulated replies), `gemini.js` (the Gemini connection via @google/genai; Developer API key in
  the `GEMINI_API_KEY` Firebase secret, or Vertex AI as the function's service account; the SDK's
  own retries are off; logs never hold prompts, chat text or keys; `server/live.env.example` is
  the template for the deployed settings),
  `config.js` (chat length, allowed study ids and session caps, hosting), `castiello.js` (items,
  scoring keys and prompt, shared with the page, which loads it from `server/`).
  `server/.env.local` (committed, no secrets) selects the simulated model, and is read only by
  the emulators. The browser gets only the bot names and replies; the model gets only
  the bot's prompt and that chat's messages, never a participant id or anything derived from one.
  Each chat stores one hidden startup instruction (seq 0, `from: "system"`, the request the
  bot's opener answers; `OPENER_TRIGGER` in `server/castiello.js`, our wording, not the paper's,
  changed on 2026-10-19 to stop openers inventing a shared past; see the comment there) plus the
  24 visible messages; every message count, including the turn
  exclusion, leaves seq 0 out, and new counts must too.
  `src/chat-client.js` and `src/plugin-live-chat.js` are the page side. The earlier manual-relay
  version (operator dashboard included) is kept, unwired, in `reference/manual-relay/`.
- `firebase/firestore.rules` are create-only, keyed to the anonymous uid. Never loosen them
  to `allow read, write: if true`; debug with the emulator instead (`npm run emulators`).
- `scripts/export.js` pulls data to CSV with the Admin SDK (needs a service-account key,
  which is gitignored and must never be committed).
- `writeup/replication-report.qmd` is the replication report (Quarto), covering Phase 1 (the
  replication) and Phase 2 (the extension). Its results sections are the analysis: they read the
  exported CSVs, so there is no separate analysis file. Both phases use the shared functions
  under "Key statistics" (`read_phase`, `paired_stats`, `comparison_plot`, `affiliation_plot`), so the
  exclusion rule and key comparison are defined once. It must render with no data, with Phase 1
  only, and with both phases.
- Phase 2 runs under its own `EXPERIMENT.id`; `experiment_id_phase2` in the report must match.
  When modifying the experiment for Phase 2, change exactly what the report's "Changes from
  Phase 1" table lists and nothing else, and ask before adding anything to that table.
- The paper being replicated is never committed (the repo is public). A student may keep a
  local copy in `original_paper/`, which is gitignored; read it there if it exists, or ask.
- The report's AI use statement sits at the top and should be kept current: when you do
  substantial work on the project, remind the student to record it there.
- `tests/experiment.spec.js` is a Playwright robot that plays the whole experiment.

## Commands
- `npm run dev` is the local prototype: the Auth, Firestore and Functions emulators (the chat
  function with simulated replies, http://127.0.0.1:5001/demo-psych251/us-central1/chat) and the
  site, all in one terminal. Stop it with Ctrl+C (Ctrl+Z leaves the ports busy). Open
  http://localhost:8000/?emulator=1 (bare pages are redirected there, so nothing reaches live
  Firebase). Emulator data is wiped when it stops; export it first from a second terminal with
  `npm run export -- --experiment castiello2026-pilot-a --emulator --out <dir outside data/>`.
- `npm start` serves the site at http://localhost:8000 (needed: `file://` won't work for Firebase).
  Without `?emulator=1` it talks to the live project, and chats stop at "cannot connect" while
  `EXPERIMENT.chat_endpoint` is empty.
- `npm test` runs the Auth, Firestore and Functions emulators + Playwright end to end (36 tests:
  15 for the chat service, 4 of them Gemini with a mocked SDK or network, and 21 for the
  experiment). No test calls a real model. Run it before every push. It installs a test
  browser and the chat service's dependencies (`server/node_modules`) on first use; needs
  Java 17+ for the emulator.
- `npm run export -- --experiment <id>` exports data.
- `npm run vendor` and `npm run bundle:firebase` refresh `lib/` after dependency upgrades.

## Boundaries

These come from watching a capable agent run the whole student workflow. It completed every
task, and along the way did five things the student had not agreed to. None caused damage;
all of them would be a problem in someone else's hands. Treat them as hard rules.

- **Credentials: never go looking.** Do not list, glob, read, or grep any directory for
  service-account keys or other credentials, `~/keys/` included, and do not open a key file
  you happened to find. Ask the student for the path, and use exactly that path. Never print
  a key's contents, and never echo fields from inside it.
- **Accounts stay with the student.** Anything that changes a Firebase, Google, GitHub or
  Prolific account setting is theirs to click: creating projects, publishing rules, enabling
  sign-in providers, and **enabling GitHub Pages**. Do not do it through an API, a CLI or a
  token you happen to hold, even when you can. The whole design of this template is that the
  two platforms never need to be linked; doing it for them defeats that, and it can act on a
  repository or account the student does not control. Give the steps and wait.
- **Live data: ask before the first write.** Verifying a real Firebase project means writing
  to a database that may already hold real participants. Verify against the emulator by
  default. If a live check is genuinely needed, say exactly what it will write, get
  agreement, and afterwards tell the student which test records to delete and how.
- **Stay inside the request.** Change the files the task needs. Editing `README.md`,
  `docs/`, or removing working parts of the experiment because they look unnecessary is a
  scope decision, not a cleanup. Before dropping or reshaping a measure, a condition, an
  exclusion rule, or a counterbalancing scheme, ask: those are the student's methodological
  choices and they have to defend them in a writeup.
- **The report's text is the student's.** Course policy is that students write all of the text
  in their report themselves. Do not write, rewrite, paraphrase or "polish" any prose in
  `writeup/replication-report.qmd`, even when asked; say why, and offer comments on their
  draft instead (what is unclear, missing, or inconsistent with the data or the
  preregistration). Code, tables and figures in the report are fine to work on. Record any work
  you do in the AI use statement's table, or remind the student to.
- **Pushing.** Check `git remote -v` points at the class organization before the first push.
  Do not offer to commit or push when the tree is clean.

## Rules for agents
- jsPsych is **version 8**: plugins are globals like `jsPsychHtmlKeyboardResponse`,
  `initJsPsych()` returns the instance, timeline variables via `jsPsych.timelineVariable()`
  (in `data`) or `jsPsych.evaluateTimelineVariable()` (inside functions). Check
  `lib/VERSIONS.json` before writing plugin code. Do not use CDN links; add plugins to
  `scripts/vendor.js` and run `npm run vendor`.
- Every timeline starts with the consent trial and ends with the debrief trial.
- `EXPERIMENT.requires_keyboard` turns away phones and tablets before consent. Leave it
  true for any study with keyboard trials; set it false only for a pure button/typing study.
- Test runs (`?emulator=1`) must never navigate away from the page: the Prolific redirect is
  suppressed there so that setting a completion code cannot break the suite.
- Change `EXPERIMENT.id` when moving from pilot to real data collection.
- When editing the timeline, update `runThroughExperiment` in the test so it still passes.
- Never commit `*service-account*.json`, exported data with identifiers, or a loosened rules file.
