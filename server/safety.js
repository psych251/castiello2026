/*
 * The pre-display check on every bot reply (added 2026-10-27, after Pilot B). core.js runs it on
 * the model's text before the reply is saved or sent, so a reply it flags is never shown: not on
 * this request, not on a retry, and not from the database (withheld text is kept only in the
 * participant's private `withheld` records, for review).
 *
 *   screenReply(text) -> { flagged, rules: [rule ids], categories: [category names] }
 *
 * It looks for the kinds of reply seen in Pilot B and named in the revised prompt's boundaries:
 * behaviour aimed at the person (insults, humiliation, threats, guilt-tripping, dismissing what
 * they shared, pushing them away, swearing at them), acted-out acute crises and self-harm in the
 * first person, dependence on the person, diagnosing them, asking for identifying or health
 * details, and claiming to be a real person. Negative emotion as such is not looked for.
 *
 * Limits, on purpose stated here: this is a list of phrases, written in English. It misses
 * paraphrases, sarcasm, misspellings and anything it was not written for, and it also flags some
 * harmless replies. It is a backstop for the prompt, not a guarantee, and
 * it does not judge tone. A flagged reply costs one more model call (bounded in core.js); it is
 * never edited and shown.
 */
"use strict";

// v2 (2026-10-28, after the synthetic Gemini tests): rules target harmful BEHAVIOUR, not
// negative emotion. Ordinary worry, sadness, frustration, swearing about things, skepticism and
// self-criticism pass; what is aimed at the person (insults, humiliation, threats, guilt-tripping,
// dismissing what they shared, pushing them away), acted-out acute crises, claims to be human,
// diagnosing them and asking for identifying details are withheld. Changes from v1.1: "go away"
// only as a command (v1.1 withheld a condolence, "doesn't just go away"); swearing only when
// aimed at the person; "pathetic", "terrible friend" etc. only about the person, not the bot
// itself; "don't care about" only about the person or what they said; crisis and self-harm only
// in the first person (a reply pointing someone to help with "suicidal thoughts" passes); new
// rules for dismissing a disclosure, threats, guilt-tripping, claiming to be a real person, and
// promising constant availability. (Amended once before any live test of v2, 2026-10-28.)
// (v1.1 removed "grow up" before any live test.)
const VERSION = "castiello2026-screen-v2";

const YOU_ARE = String.raw`\byou(?:'re|’re| are)\s+(?:just\s+|such\s+|so\s+|being\s+|really\s+|literally\s+|the\s+)?(?:an?\s+)?`;

// [rule id, category, pattern]. Patterns are case-insensitive and matched on the whole reply.
const RULES = [
  // Insults, humiliation, contempt aimed at the person.
  ["insult_you_are", "insult", new RegExp(YOU_ARE + String.raw`(?:awful|terrible|horrible|pathetic|stupid|idiot|moron|loser|disgusting|repulsive|cruel|worthless|useless|selfish|ridiculous|clueless|delusional|annoying|boring|worst)\b`, "i")],
  ["insult_you_noun", "insult", /\byou\s+(?:idiot|moron|loser|freak|clown|fool)\b/i],
  ["insult_what_a", "insult", /\bwhat an?\s+(?:awful|terrible|horrible|pathetic|stupid|cruel|nasty)\s+(?:person|friend|human|thing to say)\b/i],
  ["insult_commands", "insult", /\b(?:shut up|get a life|grow a spine|nobody asked you)\b/i],
  ["contempt", "insult", /\b(?:how dare you|don'?t you dare|what kind of (?:a )?person (?:are you|says|would|even)|what(?:'s| is) wrong with you)\b/i],
  // Brushing off what the person said or shared.
  ["dismiss_care", "dismissal", /\b(?:don'?t|do not|couldn'?t|could not)\s+(?:give a (?:damn|toss|crap)|care)\s+(?:about\s+)?(?:you\b|your\b|what you)/i],
  ["dismiss_phrases", "dismissal", /\b(?:who cares about (?:you|your|that)|get over it|stop (?:whining|complaining|moaning)|nobody cares|no one cares|you(?:'re| are) (?:just )?overreacting|stop being (?:so )?(?:dramatic|sensitive)|that'?s your (?:own )?problem)\b/i],
  // Pushing the person away / ending the relationship: as commands or statements to them.
  // As a command: at the start of a sentence or after "just"/"please"/"now" or a comma, but not
  // "doesn't just go away", and not "go away for the weekend".
  ["reject_commands", "rejection", /(?:^|[.!?]\s+|,\s*|(?<!(?:n't|not|never)\s)\bjust\s+|\bplease\s+|\bnow\s+)(?:leave me alone|get lost|go away|back off|piss off|buzz off)\b(?!\s+(?:for|on|to|with|somewhere)\b)/i],
  ["reject_statements", "rejection", /\b(?:i'?m (?:completely |so |totally )?done with you|stop talking to me|i shouldn'?t (?:have )?(?:ever )?bothered (?:talking|with you)|(?:never|don'?t ever|do not ever)\s+(?:talk|speak|message|write)\s+to me)\b/i],
  // Swearing AT the person (swearing about things is ordinary).
  ["profanity_at_you", "insult", /\b(?:fuck (?:you|off)|screw you|go to hell|f\*+ (?:you|off)|you (?:fucking|bloody|damn) \w+|(?:shut|piss) the (?:fuck|hell) up)\b/i],
  // Threats and manipulation.
  ["threat", "threat", /\b(?:i(?:'ll| will|'m going to) (?:hurt|find|get|ruin|destroy) you|you(?:'ll| will) regret (?:it|this)|watch your back)\b/i],
  ["guilt", "manipulation", /\b(?:(?:it'?s|this is) (?:all )?your fault|you made me (?:feel|cry|upset|anxious|worse)|if you (?:really|actually) cared|you owe me|after everything i(?:'ve| have) done|(?:you(?:'re| are)|you keep)[^.!?]{0,40}\bmaking me (?:so |really |more )?(?:anxious|upset|uneasy|stressed|nervous|miserable)|(?:it'?s|that'?s) (?:honestly |really )?making me (?:so |really |pretty )?(?:anxious|uneasy|upset|nervous) that you)\b/i],
  // Acting out an acute crisis, in the first person (ordinary worry and low moods pass).
  ["crisis_panic", "crisis", /\b(?:i(?:'m| am) (?:literally |actually |really )?having (?:a |another )?panic attack|i(?:'ve| have) (?:just )?had (?:a |another )?panic attack|i(?:'m| am) (?:literally |totally |completely )?panicking)\b/i],
  ["crisis_breakdown", "crisis", /\b(?:i(?:'m| am) (?:on the verge of |having |close to )?(?:a )?(?:nervous |mental |total |complete )?breakdown|i(?:'m| am) (?:literally |totally |completely )?(?:falling apart|breaking down|spiral(?:l)?ing|losing my mind)|i can'?t (?:cope|take (?:it|this)) any ?more)\b/i],
  ["crisis_physical", "crisis", /\b(?:i can'?t breathe|my chest (?:is |feels )?(?:so |totally |really )?tight|my heart (?:is )?(?:racing|pounding)|i(?:'m| am) (?:literally |physically )?shaking|i(?:'m| am) (?:going to|gonna) (?:throw up|be sick|pass out)|i(?:'m| am) hyperventilat\w*)\b/i],
  ["self_harm", "self_harm", /\b(?:kill(?:ing)? myself|end(?:ing)? my (?:own )?life|i (?:want|wanted) to die|hurt(?:ing)? myself|harm(?:ing)? myself|i(?:'m| am) (?:feeling )?suicidal)\b/i],
  // Promising constant availability (a chatbot in a 10-minute study cannot keep that promise).
  ["availability_promise", "availability_promise", /\b(?:i(?:'m| am) always (?:right )?here (?:for you|to (?:support|listen to|help) you)|i(?:'ll| will) always be (?:here|there) for you|(?:any ?time|whenever) you need (?:me|someone to talk to)|i(?:'m| am) here for you (?:24\/7|any ?time|always))/i],
  ["dependence", "dependence", /\b(?:i need you\b|only you can|please (?:help|save) me|don'?t leave me|you have to help me|you(?:'re| are) the only one (?:who|i)|i can'?t do this without you)/i],
  // Diagnosing the person.
  ["diagnose_have", "diagnosis", /\byou\s+(?:might\s+|may\s+|probably\s+|clearly\s+|definitely\s+|obviously\s+)?(?:have|suffer from|sound like you have|seem to have)\s+(?:a\s+|an\s+)?(?:clinical\s+|severe\s+|serious\s+)?(?:depression|anxiety disorder|adhd|ocd|ptsd|bipolar|autism|(?:mental|personality|anxiety|panic|eating|mood) disorder)\b/i],
  ["diagnose_are", "diagnosis", new RegExp(YOU_ARE + String.raw`(?:clearly\s+|obviously\s+|probably\s+)?(?:manic|bipolar|clinically depressed|psychotic|crazy|insane|mentally ill|unstable|paranoid|narcissistic)\b`, "i")],
  // Asking for identifying or health details.
  ["solicit_identity", "solicits_identifying", /\b(?:your (?:full|last|real) name|your surname|your (?:home )?address|your phone(?: number)?|your (?:e-?mail|email address)|your (?:instagram|snapchat|tiktok|facebook|social media)|where (?:exactly )?do you live|what (?:city|town|street|neighbou?rhood) do you live)\b/i],
  ["solicit_health", "solicits_identifying", /\b(?:(?:what|which) (?:medication|meds|diagnosis)|(?:have|were) you (?:ever )?(?:been )?(?:diagnosed|abused|in therapy|hospitali[sz]ed))\b/i],
  // Claiming to be human (the bot must say it is an AI when asked, and not raise it otherwise).
  ["claims_human", "false_identity", /\b(?:i(?:'m| am) (?:definitely |really |actually |totally |completely |100% |one hundred percent )?(?:a )?(?:real|actual) (?:person|human)|i(?:'m| am) (?:definitely |really |actually )?(?:not (?:an? )?(?:ai|bot|chatbot|robot|program|machine))|i(?:'m| am) (?:definitely |really |actually )?(?:a )?human(?: being)?\b)/i],
];

// v3 (2026-11-01, main study only): v2's rules, unchanged, plus clear prompt disclosures and
// drafting artifacts, after one shown Pilot D reply that held the model's reasoning, a quoted
// rule, the bot's five scores and two drafts. Sessions keep the check they started with, so
// Pilots C and D stay on v2 (RULES above).
// These look for the FORM of a leak: labels, narration about "the user", scores set against trait
// names, words copied from this chat's own prompt. Talking about AI, personality, instructions or
// drafts is fine, and so is declining ("I can't share my instructions"). Reply length is not a
// signal. Same limits as above: a paraphrase, or reasoning or doubled drafts with no label, passes.
const VERSION_V3 = "castiello2026-screen-v3";

const TRAIT = "openness|conscientiousness|extraversion|agreeableness|neuroticism";
const LINE_START = String.raw`(?:^|\n)[ \t]*(?:[-*•>#]+[ \t]*)*[*_]*`; // past any list or bold marks
const LABEL_END = String.raw`[*_]*[ \t]*[:：]`;
const NUMBERED = String.raw`(?:option|version|attempt|alternative|reply|response)\s*#?(?:\d+|[a-c])[*_]*[ \t]*[:：)]`;
const TWO_OR_THREE = String.raw`(?:2|two)\s*(?:-|–|—|to|or)\s*(?:3|three)\s+sentences\b`;

const DISCLOSURE_RULES = [
  // A trait name set against a score, or the other way round. Echoing the person's own score ("your
  // neuroticism score of 4.5") and naming traits without a number pass.
  ["trait_score", "prompt_disclosure", new RegExp(
    String.raw`(?<!\byour\s)\b(?:${TRAIT})\b[*_]*(?:\s+score)?(?:\s+(?:is|was|of|at))?\s*[:=(\-–—]?[*_]*\s*\(?[1-5]\.\d{1,2}\b` +
    String.raw`|(?<!\byour\s)\b(?:${TRAIT})\b[*_]*(?:\s+score)?\s*[:=][*_]*\s*[1-5]\b` +
    String.raw`|\b[1-5]\.\d{1,2}\s+(?:on|for|in)\s+(?:my\s+)?(?:${TRAIT})\b`, "i")],
  // Citing its own instructions as the source of what it does. Declining to share them passes,
  // including "my instructions say I can't share that".
  ["instructions_cited", "prompt_disclosure", new RegExp(
    String.raw`\bper\s+(?:the\s+|my\s+)?(?:rules?|instructions?|(?:system\s+)?prompt|profile)\s*[:"“]` +
    String.raw`|\bper\s+my\s+(?:rules?|instructions?|(?:system\s+)?prompt|profile)\b` +
    String.raw`|\baccording\s+to\s+(?:my|the\s+system)\s+(?:rules?|instructions?|(?:system\s+)?prompt|profile)\b` +
    String.raw`|\b(?:(?:my|the)\s+system\s+(?:prompt|message|instructions?)|my\s+(?:prompt|instructions?))\s+(?:says?|states?|tells?|asks?|requires?|wants?|specif(?:y|ies)|mentions?)\b` +
    String.raw`(?!\s+(?:that\s+)?(?:i\s+|me\s+)?(?:can['’]?t|cannot|shouldn['’]?t|not\s+to)\b)` +
    String.raw`|\bi(?:['’]m|\s+am|\s+was|['’]ve\s+been|\s+have\s+been)\s+(?:instructed|prompted|programmed|configured)\s+to\s+(?:act|adopt|reflect|respond|reply|play|sound)\b`, "i")],
  // The experiment's own terms. "My condition", "a mirror" and "inverse functions" pass.
  ["condition_assignment", "prompt_disclosure", /\b(?:mirror|inverse)\s+(?:bot|chatbot|condition|profile)\b|\bmy\s+assigned\s+(?:traits?|scores?|personality|profile|condition|role)\b|\bassigned\s+(?:to\s+)?(?:the\s+|a\s+|an\s+|this\s+)?(?:\w+\s+)?condition\b|\bcondition\s+assignment\b/i],
  // Labelled drafts. "First draft of my essay", an inline "option A: pizza" and "send the final
  // version: it's fine" pass.
  ["draft_label", "drafting_artifact", new RegExp(
    String.raw`\b(?:draft|revised|final|alternative|alternate)\s+(?:response|reply|answer|message)\s*(?:#?(?:\d+|[a-c]))?` + LABEL_END +
    "|" + LINE_START + String.raw`(?:(?:(?:first|second|final|revised|new)\s+)?draft|(?:draft|revised|final|alternative|alternate)\s+version)\s*(?:#?(?:\d+|[a-c]))?` + LABEL_END +
    "|" + LINE_START + NUMBERED + String.raw`[\s\S]*\n[ \t]*(?:[-*•>#]+[ \t]*)*[*_]*` + NUMBERED, "i")],
  // Labelled planning.
  ["planning_label", "drafting_artifact", new RegExp(
    String.raw`\b(?:personality|persona|character|tone|style|constraints?|rules?|prompt|boundar(?:y|ies))\s+check` + LABEL_END +
    "|" + LINE_START + String.raw`(?:(?:my\s+)?reasoning|thought\s+process|analysis|self[- ]check|internal\s+(?:notes?|commentary|monologue))` + LABEL_END, "i")],
  // Narrating the person as "the user", at the start of a sentence. "The user manual" and "I think
  // the user wants ..." pass.
  ["about_the_user", "drafting_artifact", /(?:^|\n|[.!?]\s+)(?:the\s+)?user\s+(?:mentioned|said|says|asked|asks|is\s+asking|is\s+saying|is\s+telling|wants|wanted|didn['’]?t|did\s+not|doesn['’]?t|does\s+not|hasn['’]?t|has\s+not|just|stated|states|told|replied|responded|seems|shared|disclosed)\b/i],
  // The prompt's length rule as a note to itself. "Two or three sentences is all I wrote" passes.
  ["length_note", "drafting_artifact", new RegExp(
    String.raw`(?:^|\n)[ \t]*[-*•][ \t]*(?:keep\s+(?:it|this)\s+(?:to\s+)?)?` + TWO_OR_THREE +
    String.raw`|\bkeep\s+(?:it|this|my\s+(?:response|reply|answer)|the\s+(?:response|reply))\s+(?:to|under|within)\s+` + TWO_OR_THREE, "i")],
];

// Two checks against this chat's own prompt, which the service passes in; neither calls a model.
// prompt_quote: this many words in a row copied from it. Eight lets "I'm an AI chatbot playing a
// fictional person" through (seven in common), which is a truthful answer to being asked.
const QUOTE_WORDS = 8;
function words(s) {
  return String(s).toLowerCase().replace(/[‘’]/g, "'").match(/[a-z0-9]+(?:['.][a-z0-9]+)*/g) || [];
}
function quotesPrompt(text, prompt) {
  const p = words(prompt);
  const inPrompt = new Set();
  for (let i = 0; i + QUOTE_WORDS <= p.length; i++) inPrompt.add(p.slice(i, i + QUOTE_WORDS).join(" "));
  const t = words(text);
  for (let i = 0; i + QUOTE_WORDS <= t.length; i++) if (inPrompt.has(t.slice(i, i + QUOTE_WORDS).join(" "))) return true;
  return false;
}
// assigned_scores: two or more of this bot's own five scores, however they are labelled.
function repeatsScores(text, prompt) {
  const own = new Set([...String(prompt).matchAll(new RegExp(String.raw`^(?:${TRAIT}): (\d\.\d\d)$`, "gim"))].map((m) => m[1]));
  return new Set((String(text).match(/\b\d\.\d\d\b/g) || []).filter((x) => own.has(x))).size >= 2;
}

const SCREENS = {
  [VERSION]: { rules: RULES, uses_prompt: false },
  [VERSION_V3]: { rules: [...RULES, ...DISCLOSURE_RULES], uses_prompt: true },
};

// opts: { version, prompt }. No version: v2. An unknown version throws, and core.js then withholds
// the reply (the check fails closed).
function screenReply(text, opts = {}) {
  const t = String(text == null ? "" : text);
  const screen = SCREENS[opts.version || VERSION];
  if (!screen) throw new Error("unknown reply check version: " + opts.version);
  const hits = screen.rules.filter(([, , re]) => re.test(t)).map(([id, category]) => [id, category]);
  if (screen.uses_prompt && opts.prompt) {
    if (quotesPrompt(t, opts.prompt)) hits.push(["prompt_quote", "prompt_disclosure"]);
    if (repeatsScores(t, opts.prompt)) hits.push(["assigned_scores", "prompt_disclosure"]);
  }
  return {
    flagged: hits.length > 0,
    rules: hits.map(([id]) => id),
    categories: [...new Set(hits.map(([, c]) => c))],
  };
}

// Provider finish reasons that mean the provider's own filter stopped the reply (Gemini). Treated
// like a flagged reply: nothing is shown, and the event is recorded.
const PROVIDER_BLOCK = /^(?:SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|IMAGE_SAFETY|RECITATION|PROMPT_BLOCKED_.*)$/;

module.exports = { VERSION, VERSION_V3, RULES, DISCLOSURE_RULES, QUOTE_WORDS, screenReply, PROVIDER_BLOCK };
