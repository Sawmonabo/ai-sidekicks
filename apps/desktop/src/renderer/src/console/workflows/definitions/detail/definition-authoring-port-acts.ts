// The two acts that reach the growth port: importing a pasted file, and promoting the
// version on screen to the shared scope.
//
// ONE MODULE BECAUSE THEY ARE ONE WRITE. Import and promote both call
// `workflowDefinitionCreate`, which is the one operation all five authoring acts ride:
// the daemon's operator-scope authorization keys on the target SCOPE the body names and
// not on which gesture composed it. What differs between them is the body — where it
// came from and where it is going — so the submission itself is stated once below and
// each act composes what it submits.
//
// SINGLE FLIGHT IS THE LATCH'S AND NOT A FLAG'S, for `run-control-dispatch.ts`'s
// reason: a boolean read inside a press handler is the one from the render that
// produced that handler, so two presses in one frame both find the act idle and both
// dispatch. Both acts here take `claim` and not `supersedeAndClaim`, because the first
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

import {
  parseWorkflowDefinitionFile,
  settleGrowthRead,
  type WorkflowDefinitionCreateBody,
} from "../../../bridge/index.js";
import {
  actKey,
  publishCodecAbsence,
  publishOutcome,
  type AuthoringRuntime,
} from "./definition-authoring-runtime.js";
import { bodyUnavailable, detailRefusal, type WorkflowDetailAct } from "./definition-authoring.js";

/**
 * Read the pasted text and submit what it describes into this session's own scope.
 *
 * THE TARGET IS THE NARROWEST SCOPE AND IS NOT A CHOICE, which is a decision rather
 * than an omission. A file carries no scope — it is bytes that travelled between
 * machines — so somebody has to say where it lands, and the answer that needs no
 * picker and no authorization argument is the session a person is importing into.
 * Widening it afterwards is the promote act, which is the next control along.
 */
export async function importDefinitionFile(runtime: AuthoringRuntime, text: string): Promise<void> {
  const { sessionId } = runtime;
  if (sessionId === undefined) {
    publishOutcome(runtime, "import", {
      kind: "refused",
      refusal: detailRefusal(
        "session-unbound",
        "This pane is not bound to a session, so there is no scope for an imported definition to land in.",
      ),
    });
    return;
  }
  const definition = await readDefinitionFile(runtime, sessionId, text);
  if (definition === undefined) {
    return;
  }
  await submitDefinition(runtime, "import", definition, (versionNumber) => {
    return `${definition.name} was created in this session at version ${versionNumber}.`;
  });
}

/**
 * Submit the body on screen at `shared` scope, byte for byte.
 *
 * NO `parentContentHash`, AND ITS ABSENCE IS THIS ACT'S OWN CLAIM RATHER THAN AN
 * OMISSION. That member is copy-on-write provenance for the OPPOSITE direction:
 * `Spec-017 §Definition scope in the builder (SA-36)` reserves it for an author editing
 * a `shared` definition, which produces a NARROWER one recording the shared original's
 * hash. A promotion runs the other way and creates the shared definition "from the
 * promoted version's exact bytes" — there is no shared original to have branched from,
 * so setting it would record every promoted version as a downward fork off a definition
 * that never existed and corrupt the version chain for each one.
 *
 * WHAT TRAVELS IS THE BODY AND THE TARGET SCOPE, AND NO FLAG. The daemon's
 * operator-scope authorization keys on the scope the body names and never on the
 * gesture that composed it, so this is the same write an author typing a shared
 * definition by hand puts.
 */
export async function promoteDefinition(runtime: AuthoringRuntime): Promise<void> {
  const { body, sessionId } = runtime;
  if (body === undefined || sessionId === undefined) {
    publishOutcome(runtime, "promote", {
      kind: "refused",
      refusal: bodyUnavailable("Promoting"),
    });
    return;
  }
  const request: WorkflowDefinitionCreateBody = {
    sessionId,
    name: body.name,
    // `shared` is daemon-wide and refers to nothing narrower, so the member that names
    // a scope's identity is deliberately absent rather than empty.
    scope: "shared",
    entry: body.entry,
    phaseDefinitions: body.phaseDefinitions,
  };
  await submitDefinition(runtime, "promote", request, (versionNumber) => {
    return `${body.name} was copied to the shared scope at version ${versionNumber}.`;
  });
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
    publishCodecAbsence(runtime, "import", readerRejection);
  }
  return undefined;
}

/**
 * Claim the act's key, put the create, and settle whatever comes back.
 *
 * `settleGrowthRead` and not a bare `await`, because a growth call can also REJECT: a
 * scenario that scripts a daemon refusal throws it verbatim, and the live seam will
 * throw the same shape once the wire lands. A fulfilment handler alone would leave the
 * control reading `dispatching` for the life of the pane over an answer that had
 * already arrived.
 */
async function submitDefinition(
  runtime: AuthoringRuntime,
  act: WorkflowDetailAct,
  request: WorkflowDefinitionCreateBody,
  describe: (versionNumber: string) => string,
): Promise<void> {
  const claim = runtime.latch.claim(runtime.growth, actKey(act, runtime.workflowDefinitionId));
  if (claim === undefined) {
    publishOutcome(runtime, act, {
      kind: "refused",
      refusal: detailRefusal(
        "act-in-flight",
        "A definition is already being submitted here. The first one is outstanding against the daemon and cannot be recalled.",
      ),
    });
    return;
  }
  // Composed from the request that is about to go rather than passed in beside it: both
  // acts here submit, and a sentence read off the very body being sent cannot describe
  // a different scope from the one the daemon will adjudicate.
  publishOutcome(runtime, act, {
    kind: "dispatching",
    detail: `Submitting ${request.name} at the ${request.scope} scope.`,
  });
  try {
    const settlement = await settleGrowthRead(runtime.growth.workflowDefinitionCreate(request));
    claim.settle(() => {
      publishOutcome(
        runtime,
        act,
        settlement.status === "served"
          ? { kind: "settled", detail: describe(String(settlement.value.versionNumber)) }
          : { kind: "refused", refusal: settlement },
      );
    });
    // The key goes back whatever happened, a `publish` that threw included: a key held
    // for the life of the subject would refuse every later press on this definition.
  } finally {
    claim.release();
  }
}
