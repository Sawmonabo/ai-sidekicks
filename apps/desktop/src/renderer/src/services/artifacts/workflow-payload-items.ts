// A step payload kept as an artifact: its whole bytes read back into the items an inline payload
// carries.

import { z } from "zod";

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import {
  WorkflowItemSchema,
  type WorkflowItem,
} from "@ai-sidekicks/contracts/workflow/definition/document";

import { refuse } from "#renderer/lib/refusal/contract.js";
import { callDaemon, type DaemonReply } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { readArtifactPayload } from "./payload-read.js";

/**
 * Read one step payload's artifact and answer its items, or a refusal: the read's, or
 * `payload-unreadable` when the stored bytes are not a payload. Abandoned with `signal`,
 * like any read.
 */
export async function readWorkflowPayloadItems(
  bridge: PlatformBridge,
  artifactId: ArtifactId,
  signal: AbortSignal,
): Promise<DaemonReply<WorkflowItem[]>> {
  const read = await readArtifactPayload(
    (request) => callDaemon(bridge, "artifact.read", request, { signal }),
    artifactId,
  );
  if (read.status === "refused") {
    return read;
  }
  const { content } = read.value;
  if (content.status === "opaque") {
    return unreadablePayload();
  }
  let stored: unknown;
  try {
    stored = JSON.parse(content.text);
  } catch (parseFailure: unknown) {
    if (!(parseFailure instanceof SyntaxError)) {
      throw parseFailure;
    }
    return unreadablePayload(`It is not valid JSON: ${parseFailure.message}`);
  }
  const items = WORKFLOW_ITEMS_SCHEMA.safeParse(stored);
  return items.success ? { status: "served", value: items.data } : unreadablePayload();
}

/** A stored step payload: the items exactly as an inline one carries them. */
const WORKFLOW_ITEMS_SCHEMA = z.array(WorkflowItemSchema);

// The parser's own words ride after the sentence, so a broken payload says where it broke.
function unreadablePayload(parseDetail?: string): DaemonReply<never> {
  const sentence = "This artifact does not hold step data the panel can read.";
  return {
    status: "refused",
    refusal: refuse(
      "workflows",
      "payload-unreadable",
      parseDetail === undefined ? sentence : `${sentence} ${parseDetail}`,
    ),
  };
}
