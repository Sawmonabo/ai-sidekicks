// The payload of a provider's own subagent starting and finishing under a run. The event contract
// imports this file at load, so it never imports that contract.
import { z } from "zod";

import { withEpochStamp, type SourceEpoch, type SourcePosition } from "../event/envelope.js";
import { wireFreeFormString } from "../free-form-string.js";
import { DRIVER_WIRE_HANDLE_MAX_LEN } from "../provider/driver/methods.js";
import { ProviderNameSchema, type ProviderName } from "../provider/name.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";
import { RunIdSchema, type RunId } from "./id.js";

/**
 * The `subagent.started` and `subagent.completed` payload: a helper the provider started under the
 * run `runId`, by the provider's own id, and the tool call it was opened under where the provider
 * names one. `subagentId` is unique only within its provider's run, so a completion pairs to its
 * start on `runId`, `provider` and `subagentId` together. It takes the epoch stamp.
 */
export interface SubagentLifecyclePayload {
  sessionId: SessionId;
  runId: RunId;
  provider: ProviderName;
  subagentId: string;
  parentToolCallId?: string | undefined;
  sourceEpoch?: SourceEpoch | undefined;
  sourcePosition?: SourcePosition | undefined;
}
/** Parses a {@link SubagentLifecyclePayload}. */
export const SubagentLifecyclePayloadSchema: z.ZodType<SubagentLifecyclePayload> = withEpochStamp(
  z
    .object({
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      provider: ProviderNameSchema,
      subagentId: wireFreeFormString(
        DRIVER_WIRE_HANDLE_MAX_LEN,
        "SubagentLifecyclePayload.subagentId",
      ),
      parentToolCallId: wireFreeFormString(
        DRIVER_WIRE_HANDLE_MAX_LEN,
        "SubagentLifecyclePayload.parentToolCallId",
      ).optional(),
    })
    .strict(),
);
