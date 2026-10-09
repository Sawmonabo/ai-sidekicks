// The transcript rows a Codex turn's items become: each tool call's start and end, a file change's
// patches with their counts, and the pieces of the reasoning, the reply and the plan. A built-in
// tool is named by its item type, a tool server's or a daemon tool's by the provider's own tool
// name.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TranscriptPatchReadResponse } from "@ai-sidekicks/contracts/transcript/content";

import type {
  InboundDelivery,
  LateAppendableRow,
  ThinkingUpdatePayload,
} from "../../../../session/run/inbound.js";
import type { DeliveryOperation } from "../../../../session/run/epochs.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import { readCodexPatchFiles } from "./patches.js";

/** One row bound for the run engine, on the binding its run is attributed on. */
export interface CodexRowDelivery {
  readonly bindingId: string;
  readonly operation: DeliveryOperation | undefined;
  readonly row:
    | LateAppendableRow
    | {
        readonly type: "assistant.thinking_update";
        readonly payload: ThinkingUpdatePayload;
        readonly text: string;
      };
  /** The prose a row other than a thinking update carries, stored beside its payload. */
  readonly body: string | undefined;
  /** The provider frame the row came from. */
  readonly method: string;
}

/** The run engine's delivery a row goes out as: a thinking update, or a row with its prose. */
export function composeCodexRowInbound(row: CodexRowDelivery): InboundDelivery {
  const operation = row.operation === undefined ? {} : { operation: row.operation };
  return row.row.type === "assistant.thinking_update"
    ? {
        kind: "thinking_update",
        bindingId: row.bindingId,
        ...operation,
        payload: row.row.payload,
        content: { body: row.row.text },
      }
    : {
        kind: "session_row",
        bindingId: row.bindingId,
        ...operation,
        row: row.row,
        ...(row.body === undefined ? {} : { content: { body: row.body } }),
      };
}

/** The run a turn's rows and flags belong to, the agent whose run it is, and the run's binding. */
export interface CodexRowRun {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly agentId: AgentId;
  readonly bindingId: string;
}

/** The item type of a command a conversation runs, which can outlive the turn that started it. */
export const CODEX_COMMAND_ITEM_TYPE = "commandExecution";

/** One row read from an item, with how the reorder buffer pairs it. */
export interface CodexItemRow {
  readonly toolCallId: string | null;
  readonly pairingRole: "initiation" | "completion" | "unpaired";
  readonly delivery: CodexRowDelivery;
}

// The item types that are a tool call, each with what its start and its end carry.
const CODEX_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
]);

// A tool item's end that is a failure rather than a result.
const CODEX_FAILED_ITEM_STATUSES: ReadonlySet<string> = new Set(["failed", "declined"]);

/** Whether an item is one of the tool calls a turn's rows show. */
export function isCodexToolItem(item: Readonly<Record<string, unknown>>): boolean {
  return typeof item["type"] === "string" && CODEX_TOOL_ITEM_TYPES.has(item["type"]);
}

function readToolName(item: Readonly<Record<string, unknown>>): string {
  const type = item["type"] as string;
  if (type === "mcpToolCall" || type === "dynamicToolCall" || type === "collabAgentToolCall") {
    return readNonEmptyString(item, "tool") ?? type;
  }
  return type;
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

// What a tool call's start shows: the command, the files, or the arguments it was called with.
function readInvocationBody(item: Readonly<Record<string, unknown>>): string | undefined {
  switch (item["type"]) {
    case "commandExecution":
      return stringify(item["command"]);
    case "fileChange":
      return stringify(readCodexPatchFiles(item).map((file) => file.path));
    case "webSearch":
      return stringify(item["query"]);
    case "imageView":
      return stringify(item["path"]);
    case "collabAgentToolCall":
      return stringify(item["prompt"]);
    default:
      return stringify(item["arguments"]);
  }
}

// What a tool call's end shows: the output, the patches in the shape the patch read answers, or
// the result or error the tool returned.
function readResultBody(item: Readonly<Record<string, unknown>>): string | undefined {
  switch (item["type"]) {
    case "commandExecution":
      return stringify(item["aggregatedOutput"]);
    case "fileChange": {
      const patches: TranscriptPatchReadResponse = { files: readCodexPatchFiles(item) };
      return JSON.stringify(patches);
    }
    case "mcpToolCall":
      return stringify(item["error"] ?? item["result"]);
    case "dynamicToolCall":
      return stringify(item["contentItems"]);
    default:
      return undefined;
  }
}

function readDurationMs(
  item: Readonly<Record<string, unknown>>,
  startedAtMs: number | undefined,
  completedAtMs: number | undefined,
): number | undefined {
  const durationMs = item["durationMs"];
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
    return durationMs;
  }
  return startedAtMs === undefined || completedAtMs === undefined
    ? undefined
    : Math.max(0, completedAtMs - startedAtMs);
}

/** The row a tool item's start becomes, opening the call's operation. */
export function readCodexToolStartRow(
  item: Readonly<Record<string, unknown>>,
  run: CodexRowRun,
  method: string,
): CodexItemRow | undefined {
  const toolCallId = readNonEmptyString(item, "id");
  if (toolCallId === undefined) {
    return undefined;
  }
  return {
    toolCallId,
    pairingRole: "initiation",
    delivery: {
      bindingId: run.bindingId,
      operation: { correlationKey: toolCallId, isOpening: true },
      row: {
        type: "tool.invoked",
        payload: {
          sessionId: run.sessionId,
          runId: run.runId,
          toolName: readToolName(item),
          toolCallId,
        },
      },
      body: readInvocationBody(item),
      method,
    },
  };
}

// The reasoning's text: its summaries, which are what the model gives, else its raw parts.
function readReasoningText(item: Readonly<Record<string, unknown>>): string | undefined {
  for (const member of ["summary", "content"]) {
    const parts = item[member];
    const text = Array.isArray(parts)
      ? parts.filter((part): part is string => typeof part === "string" && part !== "").join("\n\n")
      : "";
    if (text !== "") {
      return text;
    }
  }
  return undefined;
}

/** The row type a streamed or finished piece of prose is written as. */
export type CodexProseRowType = "assistant.message" | "assistant.thinking_update";

/**
 * The prose a finished item carries and the row it is written as: a reply, a review's report or a
 * plan as `assistant.message`, the reasoning as `assistant.thinking_update`; `undefined` for any
 * other item.
 */
export function readCodexItemProse(
  item: Readonly<Record<string, unknown>>,
): { readonly rowType: CodexProseRowType; readonly text: string } | undefined {
  switch (item["type"]) {
    case "reasoning":
      return { rowType: "assistant.thinking_update", text: readReasoningText(item) ?? "" };
    case "agentMessage":
    case "plan":
      return typeof item["text"] === "string"
        ? { rowType: "assistant.message", text: item["text"] }
        : undefined;
    case "exitedReviewMode":
      return typeof item["review"] === "string"
        ? { rowType: "assistant.message", text: item["review"] }
        : undefined;
    default:
      return undefined;
  }
}

/** One piece of an item's prose as its row, keyed by the item it came from. */
export function composeCodexProsePiece(
  run: CodexRowRun,
  itemId: string,
  rowType: CodexProseRowType,
  piece: string,
  method: string,
): CodexItemRow {
  const payload = { sessionId: run.sessionId, runId: run.runId, providerMessageId: itemId };
  return {
    toolCallId: null,
    pairingRole: "unpaired",
    delivery: {
      bindingId: run.bindingId,
      operation: undefined,
      row:
        rowType === "assistant.thinking_update"
          ? { type: rowType, payload, text: piece }
          : { type: rowType, payload },
      body: rowType === "assistant.thinking_update" ? undefined : piece,
      method,
    },
  };
}

/** The row a completed tool item becomes, its result or its failure; any other item adds none. */
export function readCodexItemCompletedRow(
  item: Readonly<Record<string, unknown>>,
  run: CodexRowRun,
  method: string,
  times: { readonly startedAtMs: number | undefined; readonly completedAtMs: number | undefined },
): CodexItemRow | undefined {
  const itemId = readNonEmptyString(item, "id");
  if (itemId === undefined) {
    return undefined;
  }
  if (!isCodexToolItem(item)) {
    return undefined;
  }
  const status = item["status"];
  const failed = typeof status === "string" && CODEX_FAILED_ITEM_STATUSES.has(status);
  const durationMs = readDurationMs(item, times.startedAtMs, times.completedAtMs);
  return {
    toolCallId: itemId,
    pairingRole: "completion",
    delivery: {
      bindingId: run.bindingId,
      operation: { correlationKey: itemId, isOpening: false },
      row: {
        type: failed ? "tool.error" : "tool.result",
        payload: {
          sessionId: run.sessionId,
          runId: run.runId,
          toolName: readToolName(item),
          toolCallId: itemId,
          ...(durationMs === undefined ? {} : { durationMs }),
        },
      },
      body: failed ? (readResultBody(item) ?? stringify(status)) : readResultBody(item),
      method,
    },
  };
}

/** The item a `item/started` or `item/completed` frame carries, or `undefined`. */
export function readCodexFrameItem(params: unknown): Readonly<Record<string, unknown>> | undefined {
  const item = isPlainObject(params) ? params["item"] : undefined;
  return isPlainObject(item) ? item : undefined;
}
