// How this tree spells a bound in an identifier, declared once.
//
// Beside the gate that reads it rather than inside it, because the vocabulary is the
// thing that grows: a bound spelled a way this tuple does not carry is a second home
// the census cannot see, and widening it has to be a one-line edit at one place
// rather than an edit to a pattern inside an assertion. `apps/desktop/AGENTS.md`
// declares a closed set once and has every consumer derive from it; this is that set
// for the naming half of "one value, one home".
//
// A WHOLE TOKEN ANYWHERE IN THE NAME, NOT A SUFFIX. This was a suffix list, anchored
// at the end of the identifier, and four real bounds walked past it because their
// bound word is interior: `MAXIMUM_LIVE_DRAFT_COUNT` leads with it, and
// `IDENTIFIER_MAX_LENGTH`, `BOUNDED_ENUMERATION_MAX_ROWS`, and
// `WHEN_CLAUSE_OVERLAP_MAX_CONTEXT_KEYS` each say what is bounded after saying that
// it is. A bound is a bound wherever the word sits, so the census splits the
// identifier on `_` and asks whether any token IS one of these words.
//
// The token test is what keeps the widening honest: `DRIVER_LIST_CAPABILITIES_METHOD`
// carries the letters of `CAP` and its token is `CAPABILITIES`, so it is not a bound
// here for the same reason it was not one under the suffix rule — and now for a
// reason that holds in every position rather than only in the last.
//
// WHAT IS IN, AND WHY EACH ENTRY IS HERE
//
//   `CAP`, `THRESHOLD`, `LIMIT`, `MAX` — the four the suffix census shipped with,
//   carried over verbatim. `CAP` is witnessed sixteen times in
//   `console/core/constants.ts`.
//
//   `MAXIMUM` — a separate entry and not a prefix of `MAX`, because the match is by
//   token: `MAXIMUM_LIVE_DRAFT_COUNT` splits to `MAXIMUM`, which `MAX` does not
//   equal. Witnessed once.
//
//   `CEILING` — witnessed nowhere in the tree today, and here because the vocabulary
//   is the thing a reviewer reads before naming a bound. An entry that matches
//   nothing costs no verdict on an existing name, and its absence is a miss.
//
// WHAT IS DELIBERATELY OUT, EACH WITH THE DECLARATION THAT KEPT IT OUT
//
//   `MIN` — the tree spells it nowhere, and a floor is not what this rule governs.
//
//   `FLOOR` — witnessed, and not by a bound: `TEXT_CONTRAST_FLOOR` and
//   `NON_TEXT_CONTRAST_FLOOR` are WCAG contrast ratios that belong beside the palette
//   that has to clear them.
//
//   `SIZE` — witnessed by `GLYPH_DEFAULT_SIZE` and `GLYPH_VIEWBOX_SIZE`: layout
//   dimensions, not bounds on a count.
//
//   `MS` — witnessed by `DATABASE_OPEN_TIMEOUT_MS` and `SCRIPTED_LATENCY_MS`:
//   durations, and the home declares four of its own, so the word separates nothing.
//
// Each of those three would turn this census red on a value that is not a cap, which
// is the failure the gate's own header rules out in terms — "Names, not values, and
// that line is deliberate."

/** The words that make an exported constant a bound. Closed; extended by amendment. */
export const BOUND_NAME_WORDS: readonly string[] = [
  "CAP",
  "CEILING",
  "LIMIT",
  "MAX",
  "MAXIMUM",
  "THRESHOLD",
];
