// Reads the routing facts of one stream frame off Claude Code's stdout: its kind, the helper it
// came from, a helper's start and end, the turn's cumulative usage, the `system/init` declaration
// and the compaction boundary. The frame itself is untrusted, so every member is narrowed and an
// absent or malformed one reads as absent.

import type { CumulativeAxisReadings } from "../../../usage-delta-accountant.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import {
  CLAUDE_SUBAGENT_START_SIGNAL,
  CLAUDE_SUBAGENT_STOP_SIGNAL,
  composeClaudeWireFrameKind,
  type ClaudeSubagentLifecycleSignal,
} from "../event-normalizer.js";
import type { ClaudeHandshakeDeclaration, ClaudeInboundFrameObservation } from "./transport.js";

// The `task_type` of a task that is a helper; a background command is another kind of task.
const CLAUDE_HELPER_TASK_TYPE = "local_agent";

// Each `modelUsage` member and the axis it is summed into.
const CLAUDE_MODEL_USAGE_AXES: readonly (readonly [string, keyof CumulativeAxisReadings])[] = [
  ["inputTokens", "input"],
  ["cacheReadInputTokens", "cachedInput"],
  ["cacheCreationInputTokens", "cacheWriteInput"],
  ["outputTokens", "output"],
];

function readStringList(source: Record<string, unknown>, key: string): readonly string[] {
  const value = source[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readHandshake(frame: Record<string, unknown>): ClaudeHandshakeDeclaration {
  return {
    slashCommands: readStringList(frame, "slash_commands"),
    skills: readStringList(frame, "skills"),
    terminalSlashCommands: readStringList(frame, "terminal_slash_commands"),
    capabilities: readStringList(frame, "capabilities"),
    permissionMode: readNonEmptyString(frame, "permissionMode") ?? null,
    fastModeState: readNonEmptyString(frame, "fast_mode_state") ?? null,
    fastModeDisabledReason: readNonEmptyString(frame, "fast_mode_disabled_reason") ?? null,
  };
}

// A helper's start from its `task_started`, and its end from the `task_notification` of a task
// that the frame names; a background command's task reads as no helper.
function readHelperLifecycle(
  frameKind: string,
  frame: Record<string, unknown>,
): ClaudeSubagentLifecycleSignal | null {
  const taskId = readNonEmptyString(frame, "task_id");
  if (taskId === undefined) {
    return null;
  }
  const parentToolUseId = readNonEmptyString(frame, "tool_use_id") ?? null;
  if (frameKind === "system/task_started") {
    return frame["task_type"] === CLAUDE_HELPER_TASK_TYPE
      ? { signal: CLAUDE_SUBAGENT_START_SIGNAL, subagentId: taskId, parentToolUseId }
      : null;
  }
  return frameKind === "system/task_notification"
    ? { signal: CLAUDE_SUBAGENT_STOP_SIGNAL, subagentId: taskId, parentToolUseId }
    : null;
}

// The turn's spend summed over every model it used; `modelUsage` on a `result` is cumulative for
// the process, so the accountant differences one reading from the last.
function readResultUsage(frame: Record<string, unknown>): CumulativeAxisReadings | null {
  const modelUsage = frame["modelUsage"];
  if (!isPlainObject(modelUsage) || Object.keys(modelUsage).length === 0) {
    return null;
  }
  const sums: Partial<Record<keyof CumulativeAxisReadings, number>> = {};
  for (const perModel of Object.values(modelUsage)) {
    if (!isPlainObject(perModel)) {
      continue;
    }
    for (const [member, axis] of CLAUDE_MODEL_USAGE_AXES) {
      const value = perModel[member];
      if (typeof value === "number" && Number.isFinite(value)) {
        sums[axis] = (sums[axis] ?? 0) + value;
      }
    }
  }
  return sums;
}

/**
 * The observation the lifecycle routes one stream frame by. A helper's own frames carry its id as
 * `agent_id`, the id its `task_started` registered; a helper frame from a build that sends only
 * `parent_tool_use_id` names no registered helper, so it is held and then refused, never shown as
 * the lead's.
 */
export function readClaudeFrameObservation(
  frame: Record<string, unknown>,
): ClaudeInboundFrameObservation {
  const frameType = readNonEmptyString(frame, "type") ?? "";
  const subtype = readNonEmptyString(frame, "subtype") ?? null;
  const frameKind = composeClaudeWireFrameKind(frameType, subtype);
  const usage = frameType === "result" ? readResultUsage(frame) : null;
  return {
    frameKind,
    subagentId:
      readNonEmptyString(frame, "agent_id") ??
      readNonEmptyString(frame, "parent_tool_use_id") ??
      null,
    cumulativeUsage: usage === null ? null : { namedTurnId: null, cumulative: usage },
    subagentLifecycle: readHelperLifecycle(frameKind, frame),
    handshake: frameKind === "system/init" ? readHandshake(frame) : null,
    compactionBoundary:
      frameKind === "system/compact_boundary" && isPlainObject(frame["compact_metadata"])
        ? { boundaryPosition: null }
        : null,
  };
}
