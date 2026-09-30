// Imports a pasted definition file by submitting the create call.
//
// The import takes `claim`, not `supersedeAndClaim`: the first press is already outstanding
// against the daemon and cannot be recalled, so a second press is refused on the control. A
// served create does not splice a new version into the definition on screen; the settlement
// says what was written and where.

import { parseWorkflowDefinitionFile } from "../definition-file/workflow-definition-file-codec.js";
import { type WorkflowDefinitionCreateBody } from "@renderer/services/wire-shapes/workflow-definition-body.js";
import {
  actKey,
  publishCodecUnavailable,
  publishOutcome,
  type AuthoringRuntime,
} from "./definition-authoring-runtime.js";
import { detailRefusal } from "./definition-authoring.js";

/**
 * Read the pasted text and submit what it describes into this session's own scope.
 * A file carries no scope, so the session being imported into is the target.
 */
export async function importDefinitionFile(runtime: AuthoringRuntime, text: string): Promise<void> {
  const { sessionId } = runtime;
  if (sessionId === undefined) {
    publishOutcome(runtime, "import", {
      kind: "refused",
      refusal: detailRefusal(
        "session-unbound",
        "This pane is not bound to a session, " +
          "so there is no scope for an imported definition to land in.",
      ),
    });
    return;
  }
  const definition = await readDefinitionFile(runtime, sessionId, text);
  if (definition === undefined) {
    return;
  }
  await submitDefinition(runtime, definition);
}

/**
 * The body the pasted text describes, or `undefined` once the refusal is published.
 * Only the reading is guarded; a daemon refusal on the submit belongs to that call.
 */
async function readDefinitionFile(
  runtime: AuthoringRuntime,
  sessionId: string,
  text: string,
): Promise<WorkflowDefinitionCreateBody | undefined> {
  try {
    const reading = await parseWorkflowDefinitionFile(text, {
      sessionId,
      scope: "session",
      scopeRef: sessionId,
    });
    if (reading.status === "parsed") {
      return reading.body;
    }
    publishOutcome(runtime, "import", {
      kind: "refused",
      refusal: detailRefusal("file-unreadable", reading.reason),
    });
  } catch (readerRejection: unknown) {
    publishCodecUnavailable(runtime, "import", readerRejection);
  }
  return undefined;
}

/**
 * Claim the import's key, put the create, and publish what comes back.
 *
 * A rejected create is not caught: it reaches the caller, and the `finally` gives the
 * key back so a later press is not refused as a duplicate of a call that ended.
 */
async function submitDefinition(
  runtime: AuthoringRuntime,
  request: WorkflowDefinitionCreateBody,
): Promise<void> {
  const claim = runtime.latch.claim(
    runtime.createDefinition,
    actKey("import", runtime.workflowDefinitionId),
  );
  if (claim === undefined) {
    publishOutcome(runtime, "import", {
      kind: "refused",
      refusal: detailRefusal(
        "act-in-flight",
        "A definition is already being submitted here. " +
          "The first one is outstanding against the background service and cannot be recalled.",
      ),
    });
    return;
  }
  // Composed from the request about to go, so the sentence cannot describe a different scope.
  publishOutcome(runtime, "import", {
    kind: "dispatching",
    detail: `Submitting ${request.name} at the ${request.scope} scope.`,
  });
  try {
    const created = await runtime.createDefinition(request);
    claim.settle(() => {
      publishOutcome(runtime, "import", {
        kind: "settled",
        detail:
          `${request.name} was created in this session at version ` +
          `${String(created.versionNumber)}.`,
      });
    });
    // The key goes back whatever happened; a key held for the subject's life would refuse every
    // later press.
  } finally {
    claim.release();
  }
}
