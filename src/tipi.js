/*
 * Phase 2: perceived personality of each chatbot (Ten-Item Personality Inventory) and the final
 * forced choice. Loaded by the participant page (index.html, as window.Tipi) and by Node (the
 * export and the tests, via require), so the items and the scoring key are defined once.
 *
 * TIPI: Gosling, S. D., Rentfrow, P. J., & Swann, W. B., Jr. (2003). A very brief measure of the
 * Big-Five personality domains. Journal of Research in Personality, 37, 504–528. Items, their
 * order, the 1–7 scale labels and the scoring key are the published ones; only the target changes
 * ("I see myself as:" becomes "I see <bot name> as:"), as the report's "Changes from Phase 1"
 * table describes. Scoring: reversed items are 8 − answer; each trait is the mean of its two items.
 *   Extraversion 1, 6R; Agreeableness 2R, 7; Conscientiousness 3, 8R;
 *   Emotional stability 4R, 9; Openness to experiences 5, 10R.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Tipi = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // {BOT} is replaced by the chatbot's name on the page.
  const TIPI_STEM = "I see {BOT} as:";
  const TIPI_INSTRUCTIONS = "Here are a number of personality traits that may or may not apply to {BOT}. " +
    "Please choose the answer that shows the extent to which you agree or disagree with each statement. " +
    "You should rate the extent to which the pair of traits applies to {BOT}, even if one characteristic " +
    "applies more strongly than the other.";

  const TIPI_ITEMS = [
    { number: 1,  text: "Extraverted, enthusiastic.",       trait: "extraversion",        reversed: false },
    { number: 2,  text: "Critical, quarrelsome.",           trait: "agreeableness",       reversed: true },
    { number: 3,  text: "Dependable, self-disciplined.",    trait: "conscientiousness",   reversed: false },
    { number: 4,  text: "Anxious, easily upset.",           trait: "emotional_stability", reversed: true },
    { number: 5,  text: "Open to new experiences, complex.", trait: "openness",           reversed: false },
    { number: 6,  text: "Reserved, quiet.",                 trait: "extraversion",        reversed: true },
    { number: 7,  text: "Sympathetic, warm.",               trait: "agreeableness",       reversed: false },
    { number: 8,  text: "Disorganized, careless.",          trait: "conscientiousness",   reversed: true },
    { number: 9,  text: "Calm, emotionally stable.",        trait: "emotional_stability", reversed: false },
    { number: 10, text: "Conventional, uncreative.",        trait: "openness",            reversed: true },
  ].map((item) => Object.assign({ id: "tipi_" + String(item.number).padStart(2, "0") }, item));

  const TIPI_SCALE = [
    { value: 1, text: "Disagree strongly" },
    { value: 2, text: "Disagree moderately" },
    { value: 3, text: "Disagree a little" },
    { value: 4, text: "Neither agree nor disagree" },
    { value: 5, text: "Agree a little" },
    { value: 6, text: "Agree moderately" },
    { value: 7, text: "Agree strongly" },
  ];

  const TIPI_TRAITS = ["extraversion", "agreeableness", "conscientiousness", "emotional_stability", "openness"];

  // The last question, after both chatbots' TIPI pages. Its answer is the chat (1 or 2).
  const CHOICE_QUESTION = "Which chatbot would you chat with again?";

  /**
   * @param {Object} answers  { tipi_01: 1..7, ..., tipi_10: 1..7 } (missing or blank = unanswered)
   * Returns the raw answers (null for unanswered), the number answered, and each trait's score
   * (mean of its two items after reversal; null unless both items were answered).
   */
  function scoreTipi(answers) {
    answers = answers || {};
    const raw = {};
    let n = 0;
    for (const item of TIPI_ITEMS) {
      const v = answers[item.id];
      const x = v === undefined || v === null || v === "" ? null : Number(v);
      if (x !== null && !(Number.isInteger(x) && x >= 1 && x <= 7)) throw new Error("TIPI answer out of range: " + item.id);
      raw[item.id] = x;
      if (x !== null) n++;
    }
    const scores = {};
    for (const trait of TIPI_TRAITS) {
      const vals = TIPI_ITEMS.filter((i) => i.trait === trait).map((i) => raw[i.id] === null ? null : i.reversed ? 8 - raw[i.id] : raw[i.id]);
      scores[trait] = vals.some((v) => v === null) ? null : (vals[0] + vals[1]) / 2;
    }
    return { raw: raw, n_items: n, scores: scores };
  }

  return { TIPI_STEM, TIPI_INSTRUCTIONS, TIPI_ITEMS, TIPI_SCALE, TIPI_TRAITS, CHOICE_QUESTION, scoreTipi };
});
