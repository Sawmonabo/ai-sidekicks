// What a scenario contract defect is, and the issue formatter its reasons are built from.
//
// A leaf: the aggregate entry answers in this shape and three axis modules construct one, so
// declaring it in any of them would make the others import a sibling for a type, and declaring it
// in the entry would close a cycle. The formatter is here so two legs reporting a schema refusal
// share one spelling of "where the issue is, and what it says".

/**
 * One way a scenario contradicts the shipped wire contract.
 *
 * A list of these rather than a thrown error, so one run reports every defect in every scenario.
 */
export interface ScenarioContractDefect {
  readonly scenarioId: string;
  /** The beat or reply at fault, in the form a failure message prints. */
  readonly subject: string;
  /** What is wrong, and what would make it right. */
  readonly reason: string;
}

/**
 * One schema issue as a sentence fragment: where it is, and what it says.
 *
 * The path is joined, as in `payload.runVersion`, because a person fixing a scenario edits that
 * member; an empty path is the whole value and is named. Typed structurally because callers pass
 * only a path and a message.
 */
export function describeSchemaIssue(issue: {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}): string {
  const location = issue.path.length === 0 ? "the event" : issue.path.map(String).join(".");
  return `${location} — ${issue.message}`;
}
