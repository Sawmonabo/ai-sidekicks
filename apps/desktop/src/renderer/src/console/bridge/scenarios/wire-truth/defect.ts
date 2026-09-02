// What a wire-truth defect is.
//
// A leaf, and it has to be one. The aggregate entry answers in this shape and three
// of the axis modules beneath it construct one, so declaring it in any of those would
// make the others import a sibling for a type — and declaring it in the entry would
// close a cycle, since the entry is what calls them.

/**
 * One way a scenario contradicts the shipped wire contract.
 *
 * A list of these rather than a thrown error, so one run reports every defect in
 * every scenario at once. A predicate that threw on the first would make fixing a
 * family's scenario a one-defect-per-run loop.
 */
export interface ScenarioWireTruthDefect {
  readonly scenarioId: string;
  /** The beat or reply at fault, in the form a failure message prints. */
  readonly subject: string;
  /** What is wrong, and what would make it right. */
  readonly reason: string;
}
