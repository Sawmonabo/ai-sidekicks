// The one act that submits nothing: serialize the version body on screen, show the
// bytes, and hand them to the host's clipboard.
//
// IT REACHES NO GROWTH OPERATION AT ALL, which is why it is its own module beside
// `definition-authoring-port-acts.ts` rather than a third branch inside it. Exporting
// reaches the host on `runs/pane/controls/enumerated-path-action.ts`'s precedent — the
// console holds no wire that writes a file, and a control that looked like it had saved
// one would be worse than the honest copy.
//
// THE SETTLEMENT IS THE HOST'S ANSWER AND NEVER THE SERIALIZATION'S. The bytes exist
// the moment they are composed and the copy does not: a host that hangs never took it,
// and one that rejects took nothing. Publishing "is on the clipboard" beside the
// serialization asserted an operation that had not happened — for as long as a hung
// call took, and forever for one that never answers — so the act stands at
// `dispatching` while the write is outstanding and only the FULFILLED promise says the
// version was copied.
//
// THE FILE IS PUBLISHED ON EVERY ARM, and that is the whole design: the surface renders
// it in a read-only box, so a host that hung or refused leaves the bytes selectable
// rather than leaving the person with nothing.
//
// THE SERIALIZATION IS AWAITED because the file form's writer arrives in its own chunk
// — the parser is charged to the launches that use it and to no others — and the only
// way it fails is a chunk that did not load. That is a fact about the install rather
// than about the definition, so it lands on the same rejection seam the clipboard's own
// refusal does rather than inventing a second refusal for this surface.
//
// THE LATCH IS `supersedeAndClaim` AND NOT `claim`, which is the one place this act
// differs from the two that submit. A second press means the same bytes again — there
// is no durable record to duplicate, so there is nothing to refuse — but two rounds
// settle in whatever order the chunk fetch and the host return them, and an older
// answer must not overwrite a newer one: a first press rejecting after a second press
// succeeded would otherwise report a copy that did happen as one that did not. THE KEY
// IS TAKEN BEFORE THE FETCH IS AWAITED, so that ordering covers the codec's answer too
// — a chunk that failed for a press already superseded may not erase what the newer
// press put on screen.

import {
  serializeWorkflowDefinitionFile,
  type WorkflowVersionBody,
} from "../../../bridge/index.js";
import { normalizeWireRejection } from "../../../core/index.js";
import type { GenerationClaim } from "../../../store/index.js";
import {
  actKey,
  publishCodecAbsence,
  publishOutcome,
  type AuthoringRuntime,
} from "./definition-authoring-runtime.js";
import { bodyUnavailable, WORKFLOW_DETAIL_ORIGIN } from "./definition-authoring.js";

/**
 * Serialize the body on screen, show the bytes, and hand them to the host's clipboard.
 *
 * The three steps are three calls rather than one block, so the seam each of them can
 * fail at reads on its own line: the body that is not there, the chunk that did not
 * arrive, and the host that would not take the copy.
 */
export async function exportDefinitionFile(runtime: AuthoringRuntime): Promise<void> {
  const { body } = runtime;
  if (body === undefined) {
    publishOutcome(runtime, "export", { kind: "refused", refusal: bodyUnavailable("Exporting") });
    return;
  }
  // Read off the body once and carried, rather than composed at each of the three
  // publishes: the sentence a person reads while the host is asked and the one they
  // read afterwards name the same version because they are the same string.
  const versionLabel = `Version ${String(body.versionNumber)} of ${body.name}`;
  const claim = runtime.latch.supersedeAndClaim(
    runtime.growth,
    actKey("export", runtime.workflowDefinitionId),
  );
  try {
    const file = await serializeFile(runtime, claim, body);
    if (file === undefined) {
      return;
    }
    publishExportedBytes(runtime, claim, file, versionLabel);
    await handToClipboard(runtime, claim, file, versionLabel);
    // The key goes back whichever arm ran, a `publish` that threw included. Nothing is
    // refused by holding it — `supersedeAndClaim` never refuses — but
    // `generation-latch.ts` bounds its register within a live subject BY release, and a
    // key never given back is an entry kept for the life of the bridge.
  } finally {
    claim.release();
  }
}

/**
 * The file the body serializes to, or `undefined` once the refusal has been published.
 *
 * THE REFUSAL IS SETTLED UNDER THE ROUND'S OWN CLAIM. A chunk fetch that failed for a
 * press somebody has already superseded says nothing about the press they are waiting
 * on, and installing it would replace a newer round's bytes with an older round's
 * excuse.
 */
async function serializeFile(
  runtime: AuthoringRuntime,
  claim: GenerationClaim,
  body: WorkflowVersionBody,
): Promise<string | undefined> {
  try {
    return await serializeWorkflowDefinitionFile(body);
  } catch (writerRejection: unknown) {
    claim.settle(() => {
      publishCodecAbsence(runtime, "export", writerRejection);
    });
    return undefined;
  }
}

/**
 * Put the bytes on screen and stand the act at `dispatching` while the host is asked.
 *
 * THE BYTES GO IN BESIDE THE OUTCOME AND NOT INSIDE IT, so the two arms below replace
 * where the act STANDS and leave what it produced on screen. And the write is the
 * round's, for `serializeFile`'s reason: a superseded press that published here would
 * put `dispatching` over a newer press's own settlement or refusal.
 */
function publishExportedBytes(
  runtime: AuthoringRuntime,
  claim: GenerationClaim,
  file: string,
  versionLabel: string,
): void {
  claim.settle(() => {
    runtime.publish((previous) => ({
      exportedFile: file,
      outcomes: {
        ...previous.outcomes,
        export: {
          kind: "dispatching",
          detail: `${versionLabel} is below. Waiting for the host to take the copy.`,
        },
      },
    }));
  });
}

/**
 * Ask the host to take the copy, and settle on whichever answer it gives.
 *
 * WHAT THE HOST SAID, NEVER A PARAPHRASE OF IT — rule 9, and the seam
 * `enumerated-path-action.ts` established for exactly this call. The fallback is
 * reached only where the rejection carried nothing machine-readable, and it says what
 * did not happen and what is still on screen rather than repeating the bytes.
 *
 * The rejection handler is `then`'s SECOND ARGUMENT rather than a `catch` link, so a
 * publish that threw on the fulfilled arm cannot arrive here and be reported as the
 * host having refused a write it had already taken.
 */
function handToClipboard(
  runtime: AuthoringRuntime,
  claim: GenerationClaim,
  file: string,
  versionLabel: string,
): Promise<void> {
  return runtime.bridge.sidekicks.native.copyToClipboard(file).then(
    () => {
      claim.settle(() => {
        publishOutcome(runtime, "export", {
          kind: "settled",
          detail: `${versionLabel} is on the clipboard, and below.`,
        });
      });
    },
    (rejection: unknown) => {
      claim.settle(() => {
        publishOutcome(runtime, "export", {
          kind: "refused",
          refusal: normalizeWireRejection(WORKFLOW_DETAIL_ORIGIN, rejection, {
            code: "call-rejected",
            detail:
              "native.copyToClipboard was rejected, so the file was not copied. It is shown below and can be selected by hand.",
          }),
        });
      });
    },
  );
}
