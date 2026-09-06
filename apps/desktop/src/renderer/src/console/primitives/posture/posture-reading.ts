// Which kind of posture reading a surface is rendering, and how much of it is open.
//
// TWO CLOSED SETS IN THEIR OWN LEAF, because both components that render a posture
// name them and one of those components renders the other. Declaring them beside the
// card presentation made the row's module import its own caller, which is a cycle
// `structure:layering` fails; declaring them twice would be two unions with a comment
// saying one mirrors the other, which the package's own rules refuse. So they live
// below both readers, where neither owns them.

/**
 * Which kind of posture reading this is.
 *
 * `stamped` is a fact about a run that happened. `intent` is a projection of
 * configured intent for the NEXT run. The two are kept visibly distinct because no
 * wire member carries an agent-level or composer-level posture — `Spec-023`'s "never
 * of a request" — and a chip that looked identical would imply one had been enforced.
 */
export type PostureReading = "stamped" | "intent";

/**
 * How much of the posture is visible before a person asks for the rest.
 *
 * `card` is the pane presentation: every fact open, because the surface exists to
 * answer this question. `row` is the per-run presentation: mode, network and the
 * writable-root count visible, the rest one disclosure away — a run list carries one
 * of these per row and a list of open definition lists is not a list of runs.
 *
 * It is a presentation and never a subset: both arms render the same posture facts,
 * so the row cannot quietly drop a member the card shows.
 */
export type PosturePresentation = "card" | "row";
