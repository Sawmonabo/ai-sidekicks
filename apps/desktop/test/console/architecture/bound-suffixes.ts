// How this tree spells a bound in an identifier, declared once.
//
// Beside the gate that reads it rather than inside it, because the vocabulary is the
// thing that grows: a bound spelled a way this tuple does not carry is a second home
// the census cannot see, and widening it has to be a one-line edit at one place
// rather than an edit to a pattern inside an assertion. `apps/desktop/AGENTS.md`
// declares a closed set once and has every consumer derive from it; this is that set
// for the naming half of "one value, one home".
//
// ANCHORED AT THE END OF THE NAME. `PERSISTENCE_RECORD_BYTE_CAP` is a bound and
// `DRIVER_LIST_CAPABILITIES_METHOD` is a method string that happens to contain the
// letters, so `CAP` has to END the name rather than merely appear in it — which is
// also what keeps `CAPABILITY` out of the result.
//
// WHAT IS IN, AND WHY EACH ENTRY IS HERE
//
//   `_CAP`, `_THRESHOLD`, `_LIMIT` — the three the census shipped with. `_CAP` is
//   witnessed sixteen times in `console/core/constants.ts`.
//
//   `_MAX` — witnessed as a bound WORD four times and never yet in final position:
//   `MAX_REPAIRABLE_SEQUENCE_GAP` and `WHEN_CLAUSE_MAX_DEPTH` in the home,
//   `IDENTIFIER_MAX_LENGTH` and `BOUNDED_ENUMERATION_MAX_ROWS` outside it. A tree
//   that already spells bounds with `MAX` will eventually put it last, and until it
//   does this entry matches nothing — which is the safe direction for an entry whose
//   absence is a miss and whose presence costs a verdict on no existing name.
//
// WHAT IS DELIBERATELY OUT, EACH WITH THE DECLARATION THAT KEPT IT OUT
//
//   `_MIN`, `_CEILING` — the tree spells neither word anywhere, in any position.
//   Minting them would be vocabulary ahead of a reader.
//
//   `_FLOOR` — witnessed, and not by a bound: `TEXT_CONTRAST_FLOOR` and
//   `NON_TEXT_CONTRAST_FLOOR` are WCAG contrast ratios that belong beside the palette
//   that has to clear them.
//
//   `_SIZE` — witnessed by `GLYPH_DEFAULT_SIZE`, `GLYPH_VIEWBOX_SIZE`,
//   `REFUSAL_GLYPH_SIZE`, `ROSTER_GLYPH_SIZE`: layout dimensions, not bounds on a
//   count.
//
//   `_MS` — witnessed by `DATABASE_OPEN_TIMEOUT_MS` and `SCRIPTED_LATENCY_MS`:
//   durations, and the home declares four of its own, so the suffix separates
//   nothing.
//
// Each of those three would turn this census red on a value that is not a cap, which
// is the failure the gate's own header rules out in terms — "Names, not values, and
// that line is deliberate."

/** The suffixes that make an exported constant a bound. Closed; extended by amendment. */
export const BOUND_NAME_SUFFIXES: readonly string[] = ["_CAP", "_THRESHOLD", "_LIMIT", "_MAX"];
