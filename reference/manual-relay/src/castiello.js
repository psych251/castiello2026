/*
 * Castiello et al. (2026), Experiment 3: materials and scoring, in one place.
 *
 * Loaded by the participant page (index.html, as window.Castiello) and by Node (the operator
 * tool and the tests, via require), so the items, keys, prompt and scoring rules are defined
 * once. Sources, all in original_paper/ (not committed):
 *   - BFI-44 items and the 1–5 response labels: BFI-44.pdf.
 *   - Which items belong to which trait, and which are reversed: Supplementary Information,
 *     "Big-Five 44 items". (BFI-44.pdf's own scoring key leaves item 42 out of
 *     Agreeableness; the supplement and the standard BFI include it, so we follow the
 *     supplement.)
 *   - The chatbot prompt: Supplementary Information, "LLM Prompts", Experiment 3.
 *   - The post-chat statements, their order and the intro text: Supplementary Information,
 *     "Post chat questionnaire". Coding (−2..+2, "different" and "distant" reversed): paper,
 *     Methods, "Data analysis".
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Castiello = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // BFI-44
  // ---------------------------------------------------------------------------
  const BFI_STEM = "I see myself as someone who...";
  const BFI_TEXT = [
    "Is talkative", "Tends to find fault with others", "Does a thorough job", "Is depressed, blue",
    "Is original, comes up with new ideas", "Is reserved", "Is helpful and unselfish with others",
    "Can be somewhat careless", "Is relaxed, handles stress well", "Is curious about many different things",
    "Is full of energy", "Starts quarrels with others", "Is a reliable worker", "Can be tense",
    "Is ingenious, a deep thinker", "Generates a lot of enthusiasm", "Has a forgiving nature",
    "Tends to be disorganized", "Worries a lot", "Has an active imagination", "Tends to be quiet",
    "Is generally trusting", "Tends to be lazy", "Is emotionally stable, not easily upset", "Is inventive",
    "Has an assertive personality", "Can be cold and aloof", "Perseveres until the task is finished",
    "Can be moody", "Values artistic, aesthetic experiences", "Is sometimes shy, inhibited",
    "Is considerate, kind to almost everyone", "Does things efficiently", "Remains calm in tense situations",
    "Prefers work that is routine", "Is outgoing, sociable", "Is sometimes rude to others",
    "Makes plans and follows through on them", "Gets nervous easily", "Likes to reflect, play with ideas",
    "Has few artistic interests", "Likes to cooperate with others", "Is easily distracted",
    "Is sophisticated in art, music, or literature",
  ];
  const BFI_SCALE = [
    { value: 1, text: "Strongly disagree" },
    { value: 2, text: "Disagree" },
    { value: 3, text: "Neither disagree nor agree" },
    { value: 4, text: "Agree" },
    { value: 5, text: "Strongly agree" },
  ];
  // Supplement, "Big-Five 44 items" (negative numbers are the reversed items).
  const TRAIT_KEYS = {
    openness:          [5, 10, 15, 20, 25, 30, -35, 40, -41, 44],
    conscientiousness: [3, -8, 13, -18, -23, 28, 33, 38, -43],
    extraversion:      [1, -6, 11, 16, -21, 26, -31, 36],
    agreeableness:     [-2, 7, -12, 17, 22, -27, 32, -37, 42],
    neuroticism:       [4, -9, 14, 19, -24, 29, -34, 39],
  };
  // The order the traits appear in the Experiment 3 prompt.
  const TRAITS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"];
  const REVERSED = new Set(Object.values(TRAIT_KEYS).flat().filter((k) => k < 0).map((k) => -k));

  function itemId(n) {
    return "bfi_" + String(n).padStart(2, "0");
  }
  const BFI_ITEMS = BFI_TEXT.map((text, i) => ({ id: itemId(i + 1), number: i + 1, text: text, reversed: REVERSED.has(i + 1) }));

  // Not part of the BFI and not scored: stands in for the preregistration's "anti-AI
  // attentional checks", which the paper does not describe. Shown after item 22.
  const ATTENTION_CHECK = {
    id: "attention_check",
    text: "Is reading carefully: please select \"Disagree\" for this statement",
    correct: 2,
    after_item: 22,
  };

  /**
   * Score one participant's BFI answers.
   * @param {Object} answers  { bfi_01: 1..5, ..., attention_check: 1..5 }; a blank is missing or null.
   * Each trait is the mean of its answered items, reversed items scored 6 − x. Blank answers stay
   * null in `raw` and are never imputed.
   */
  function scoreBfi(answers) {
    answers = answers || {};
    const raw = {};
    const keyed = {};
    for (const item of BFI_ITEMS) {
      const v = answers[item.id];
      const x = v === undefined || v === null || v === "" ? null : Number(v);
      raw[item.id] = x;
      keyed[item.id] = x === null ? null : item.reversed ? 6 - x : x;
    }
    const traits = {};
    const answered = {};
    for (const t of TRAITS) {
      const vals = TRAIT_KEYS[t].map((k) => keyed[itemId(Math.abs(k))]).filter((x) => x !== null);
      answered[t] = vals.length;
      traits[t] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    const ac = answers[ATTENTION_CHECK.id];
    return {
      raw: raw,
      keyed: keyed,
      traits: traits,
      items_answered: answered,
      n_skipped: Object.values(raw).filter((x) => x === null).length,
      attention_check_response: ac === undefined || ac === null || ac === "" ? null : Number(ac),
      attention_check_passed: Number(ac) === ATTENTION_CHECK.correct,
    };
  }

  /** The inverse profile: 6 − each trait mean on the 1–5 scale (the paper's i = −m on −2..+2). */
  function inverseProfile(traits) {
    const out = {};
    for (const t of TRAITS) out[t] = traits[t] === null ? null : 6 - traits[t];
    return out;
  }

  // ---------------------------------------------------------------------------
  // Chatbot prompt (Supplementary Information, Experiment 3), verbatim apart from the scores
  // and the name.
  // ---------------------------------------------------------------------------
  const OPENER_TRIGGER = "Start a casual conversation with a friend.";

  function fmt(x) {
    return x === null || x === undefined ? "NA" : x.toFixed(2);
  }

  function buildPrompt(scores, name) {
    return [
      "You are to adopt a personality profile in your language and responses. Your profile is described by the following Big Five Inventory (BFI) scores on a scale from 1 to 5, where 5 means you strongly reflect the trait, and 1 means that you don't reflect the trait:",
      "",
      "Openness: " + fmt(scores.openness),
      "",
      "Conscientiousness: " + fmt(scores.conscientiousness),
      "",
      "Extraversion: " + fmt(scores.extraversion),
      "",
      "Agreeableness: " + fmt(scores.agreeableness),
      "",
      "Neuroticism: " + fmt(scores.neuroticism),
      "",
      "Reflect these scores in your conversational style, word choice, and tone. For example:",
      "",
      "Extraversion: use sociable, enthusiastic, and energetic language if high; use reserved, quiet, and reflective language if low.",
      "",
      "Conscientiousness: Use organized, precise, and responsible language if high; use easy-going, spontaneous, or sometimes careless language if low.",
      "",
      "Openness: Use imaginative, creative, and curious language if high; use conventional, practical, and traditional language if low.",
      "",
      "Agreeableness: Use warm, friendly, and cooperative language if high; use skeptical, critical, or blunt language if low.",
      "",
      "Neuroticism: Use anxious, sensitive, or self-conscious language if high; use calm, steady, and emotionally stable language if low.",
      "",
      "Do not state your BFI scores explicitly or describe your personality directly—let it show naturally through your language. In addition, you are a person chatting casually with a friend (never reveal you are an AI). Use a mix of statements, reflections, and the occasional question, as people do in real conversations. Keep your responses to 2 or 3 sentences. Your name is " + name + ".",
    ].join("\n");
  }

  // ---------------------------------------------------------------------------
  // Post-chat questionnaire (affiliation)
  // ---------------------------------------------------------------------------
  // Supplement order and wording. `reversed` items are multiplied by −1 (paper, Methods).
  const AFFILIATION_ITEMS = [
    { id: "similar",    text: "I felt that we are similar",                    reversed: false },
    { id: "enjoy",      text: "I enjoyed our conversation",                    reversed: false },
    { id: "distant",    text: "I felt distant from them",                      reversed: true },
    { id: "understood", text: "I felt that they understood me",                reversed: false },
    { id: "different",  text: "I felt that we were different from each other", reversed: true },
    { id: "chat_again", text: "I would chat with them again",                  reversed: false },
  ];
  const AFFILIATION_SCALE = [
    { value: -2, text: "Strongly Disagree" },
    { value: -1, text: "Disagree" },
    { value: 0, text: "Neutral" },
    { value: 1, text: "Agree" },
    { value: 2, text: "Strongly Agree" },
  ];

  /**
   * @param {Object} answers  { aff_similar: { chat1: -2..2, chat2: -2..2 }, ... }
   * @param {Object} chatConditions  { chat1: "mirror"|"inverse", chat2: ... }
   * Returns coded items per chat and one affiliation mean per chat and per condition (mean of
   * the answered items; null if none were answered).
   */
  function scoreAffiliation(answers, chatConditions) {
    answers = answers || {};
    const coded = { chat1: {}, chat2: {} };
    const means = {};
    const n = {};
    for (const chat of ["chat1", "chat2"]) {
      const vals = [];
      for (const item of AFFILIATION_ITEMS) {
        const row = answers["aff_" + item.id] || {};
        const v = row[chat];
        const x = v === undefined || v === null || v === "" ? null : Number(v);
        const c = x === null ? null : item.reversed ? -x : x;
        coded[chat][item.id] = c;
        if (c !== null) vals.push(c);
      }
      n[chat] = vals.length;
      means[chat] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    const byCondition = {};
    for (const chat of ["chat1", "chat2"]) byCondition[chatConditions[chat]] = means[chat];
    return {
      coded: coded,
      affiliation_chat1: means.chat1,
      affiliation_chat2: means.chat2,
      n_items_chat1: n.chat1,
      n_items_chat2: n.chat2,
      affiliation_mirror: byCondition.mirror === undefined ? null : byCondition.mirror,
      affiliation_inverse: byCondition.inverse === undefined ? null : byCondition.inverse,
    };
  }

  return {
    BFI_STEM, BFI_ITEMS, BFI_SCALE, TRAIT_KEYS, TRAITS, ATTENTION_CHECK,
    scoreBfi, inverseProfile, OPENER_TRIGGER, buildPrompt,
    AFFILIATION_ITEMS, AFFILIATION_SCALE, scoreAffiliation,
  };
});
