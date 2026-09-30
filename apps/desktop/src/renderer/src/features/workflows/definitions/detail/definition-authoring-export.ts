// Copies the version body on screen to the host clipboard; it makes no daemon call. The act
// settles on the host's answer, never the serialization, and the file is shown on every arm
// so a refused copy still leaves the bytes selectable. A second press supersedes the first
// (the key is taken before the codec chunk loads) so an older answer never overwrites a newer one.

import { serializeWorkflowDefinitionFile } from "../definition-file/workflow-definition-file-codec.js";
import { type WorkflowVersionBody } from "@renderer/services/wire-shapes/workflow-definition-body.js";
import { normalizeWireRejection } from "@renderer/lib/wire-rejection.js";
import type { GenerationClaim } from "@renderer/lib/reads/generation-latch.js";
import {
  actKey,
  publishCodecUnavailable,
  publishOutcome,
  type AuthoringRuntime,
} from "./definition-authoring-runtime.js";
import { WORKFLOW_DETAIL_ORIGIN } from "./definition-authoring.js";

/**
 * Serialize the body on screen, show the bytes, and hand them to the host's clipboard.
 * The act stands at `dispatching` until the host's write fulfills or rejects.
 */
export async function exportDefinitionFile(runtime: AuthoringRuntime): Promise<void> {
  const { body } = runtime;
  // Composed once so the three publishes name the same version.
  const versionLabel = `Version ${String(body.versionNumber)} of ${body.name}`;
  const claim = runtime.latch.supersedeAndClaim(
    runtime.createDefinition,
    actKey("export", runtime.workflowDefinitionId),
  );
  try {
    const file = await serializeFile(runtime, claim, body);
    if (file === undefined) {
      return;
    }
    publishExportedBytes(runtime, claim, file, versionLabel);
    await handToClipboard(runtime, claim, file, versionLabel);
    // The key goes back on every arm; a key never released stays in the latch for the life of the
    // bridge.
  } finally {
    claim.release();
  }
}

/**
 * The file the body serializes to, or `undefined` once the refusal has been published.
 * The refusal settles under the round's claim so a superseded press cannot replace a newer
 * round's bytes.
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
      publishCodecUnavailable(runtime, "export", writerRejection);
    });
    return undefined;
  }
}

/**
 * Put the bytes on screen and stand the act at `dispatching` while the host is asked.
 * The bytes sit beside the outcome, so the later settlement leaves them on screen.
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
 * The rejection handler is `then`'s second argument, not a `catch`, so a publish that threw on
 * the fulfilled arm is not reported as the host refusing a write it had already taken.
 */
function handToClipboard(
  runtime: AuthoringRuntime,
  claim: GenerationClaim,
  file: string,
  versionLabel: string,
): Promise<void> {
  return runtime.bridge.native.copyToClipboard(file).then(
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
            detail: "The file could not be copied. It is shown below and can be selected by hand.",
          }),
        });
      });
    },
  );
}
