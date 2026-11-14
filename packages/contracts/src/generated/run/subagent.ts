// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The payload of a provider's own subagent starting and finishing under a run.

import type { SourceEpoch, SourcePosition } from "../event/envelope.js";
import type { ProviderId } from "../provider/id.js";
import type { ToolCallId } from "../provider/tool-call.js";
import type { SessionId } from "../session/id.js";
import type { RunId } from "./id.js";

/**
 * A provider's own id of one helper, unique within its provider's run.
 */
export type SubagentId = string & { readonly __brand: "SubagentId" };

/**
 * The `agent.subagent.started`, `agent.subagent.completed` and `agent.subagent.stopped` payload:
 * a helper the provider started under the run `run_id`, by the provider's own id, and the tool
 * call it was opened under where the provider names one, and the helper's own run where one was
 * started. `subagent_id` is unique only within its provider's run, so a completion pairs to its
 * start on `run_id`, `provider` and `subagent_id` together. A stop of a helper already interrupted
 * carries the run the helper runs under in `run_id` and the helper's own run in `child_run_id`. It
 * takes the epoch stamp: `source_epoch` and `source_position` come together.
 */
export interface SubagentLifecyclePayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run the helper runs under.
   */
  runId: RunId;
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The provider's own id for the helper.
   */
  subagentId: SubagentId;
  /**
   * The helper's own run, which its usage is counted toward, where the daemon started one.
   */
  childRunId?: RunId;
  /**
   * The tool call the helper was opened under, where the provider names one.
   */
  parentToolCallId?: ToolCallId;
  /**
   * The execution epoch a late row is attributed to; comes with `source_position`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `source_epoch`.
   */
  sourcePosition?: SourcePosition;
}

export { validateSubagentId, validateSubagentLifecyclePayload } from "../checks/run/subagent.js";
