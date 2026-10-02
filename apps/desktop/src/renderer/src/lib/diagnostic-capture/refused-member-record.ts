// The one way a refused parse reaches diagnostics: where the value came from and the member paths
// that failed, which the screen never shows. Paths only, never the refused value, which may be a
// user's message, a path or a credential; the validator's message quotes received values and
// goes nowhere.

import { RealClock } from "../clock.js";
import { diagnosticStampAt, windowDiagnosticCapture } from "./diagnostic-capture.js";

/** A parse's issue list, narrowed to the `path` member a record reads. */
export type RefusedMemberIssues = readonly { readonly path: readonly PropertyKey[] }[];

/** How many failing member paths one record names before it stops. */
const NAMED_FAILING_PATH_CAP = 3;

/**
 * Record one refused parse in the window's diagnostic capture as a warning. `subject` names what
 * was parsed (a method, a delivery) and leads the detail; the failing paths follow it.
 */
export function recordRefusedMemberPaths(refused: {
  /** The subsystem that parsed the value. */
  readonly source: string;
  /** The refusal code the parse was answered with. */
  readonly kind: string;
  readonly subject: string;
  readonly issues: RefusedMemberIssues;
}): void {
  const paths = refused.issues.map((issue) =>
    issue.path.length === 0 ? "the payload" : issue.path.map(String).join("."),
  );
  const named = paths.slice(0, NAMED_FAILING_PATH_CAP).join(", ");
  const more = paths.length > NAMED_FAILING_PATH_CAP ? ", and more" : "";
  windowDiagnosticCapture.record({
    at: diagnosticStampAt(new RealClock()),
    severity: "warning",
    source: refused.source,
    kind: refused.kind,
    detail: paths.length === 0 ? refused.subject : `${refused.subject} at ${named}${more}`,
  });
}
