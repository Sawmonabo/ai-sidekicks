// What a wire-truth defect is, and the one sentence fragment its reasons are built from.
//
// A leaf, and it has to be one. The aggregate entry answers in this shape and three
// of the axis modules beneath it construct one, so declaring it in any of those would
// make the others import a sibling for a type — and declaring it in the entry would
// close a cycle, since the entry is what calls them.
//
// The issue formatter is here for the same reason and on the same terms. Two legs now
// report a schema's refusal in a defect's `reason` — the beat's own registered event
// shape and the registered payload of a run kind no stream projects — and a second
// spelling of "where the issue is, and what it says" would let one leg's failure
// message drift from the other's while both stayed green.

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

/**
 * One schema issue as a sentence fragment: where it is, and what it says.
 *
 * The path is joined rather than rendered as an array because a defect's `reason` is
 * read by a person fixing a scenario, and `payload.runVersion` is the member they
 * edit. An empty path is the whole value, which is what a top-level type failure
 * reports, so it is named rather than printed as an empty string.
 *
 * Typed structurally rather than as Zod's own `$ZodIssue`: what both callers pass is
 * a path and a message, and the narrower type is the one that says so.
 */
export function describeSchemaIssue(issue: {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}): string {
  const location = issue.path.length === 0 ? "the event" : issue.path.map(String).join(".");
  return `${location} — ${issue.message}`;
}
