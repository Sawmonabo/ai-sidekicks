// The act that puts the create call: importing a pasted file.
//
// The definition create is the one operation all four authoring acts ride: the daemon's
// operator-scope authorization keys on the target SCOPE the body names and not on which
// gesture composed it.
//
// SINGLE FLIGHT IS THE LATCH'S AND NOT A FLAG'S, for `run-control-dispatch.ts`'s
// reason: a boolean read inside a press handler is the one from the render that
// produced that handler, so two presses in one frame both find the act idle and both
// dispatch. The import takes `claim` and not `supersedeAndClaim`, because the first
// press is already outstanding against the daemon and cannot be recalled — so the
// honest answer to the second is no, said out loud on the control. The export act
// beside this one takes the other arm, and `definition-authoring-export.ts` says why.
//
// NOTHING HERE MUTATES THE READ. A served create does not splice a new version into
// the definition on screen: what the pane shows stays the answer the daemon gave, and
// the settlement says what was written and where. Re-reading the definition after a
// create would be right the day this console can also address the version it just
// wrote; it addresses the definition it was opened at, and that definition's latest
// version is a different subject from the one an import just created.

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
 *
 * THE TARGET IS THE NARROWEST SCOPE AND IS NOT A CHOICE, which is a decision rather
 * than an omission. A file carries no scope — it is bytes that travelled between
 * machines — so somebody has to say where it lands, and the answer that needs no
 * picker and no authorization argument is the session a person is importing into.
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
 *
 * The reader's own refusal travels as the sentence it composed — which member is wrong
 * is the whole of what a person needs beside a paste box — and the codec's absence
 * takes the seam beside it, because a chunk that did not arrive says nothing about the
 * text. Only the reading is guarded: a daemon refusal on the submit below belongs to
 * the call that raised it.
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
  const claim = runtime.latch.takeShell(
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
  // Composed from the request that is about to go rather than passed in beside it: a
  // sentence read off the very body being sent cannot describe a different scope from
  // the one the daemon will adjudicate.
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
    // The key goes back whatever happened, a `publish` that threw included: a key held
    // for the life of the subject would refuse every later press on this definition.
  } finally {
    claim.release();
  }
}
