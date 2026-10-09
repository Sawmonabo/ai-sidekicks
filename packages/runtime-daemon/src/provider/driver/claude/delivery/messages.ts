// The transcript rows a Claude Code message frame carries: an `assistant` frame's thinking, text
// and tool calls, and a `user` frame's tool results, each a file-changing call's with its patch
// and counts. The frames are untrusted, so every member is narrowed and a block that reads as
// nothing known is left out.

import type { TranscriptPatchReadResponse } from "@ai-sidekicks/contracts/transcript/content";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { DeliveryOperation } from "../../../../session/run/epochs.js";
import type { LateAppendableRow, ThinkingUpdatePayload } from "../../../../session/run/inbound.js";
import { mintUuidV7 } from "../../../../uuid-v7.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import { isClaudeFileChangingTool, readClaudePatchFile } from "./patches.js";

/** The run a frame's rows belong to. */
interface ClaudeRowRun {
  readonly sessionId: SessionId;
  readonly runId: RunId;
}

/** A tool call the session's lead started and has not yet answered, by its `tool_use_id`. */
export interface ClaudeOpenToolCall {
  readonly toolName: string;
  readonly startedAtMs: number;
}

/**
 * One row read off a message frame, with how it pairs in the reorder buffer and the provider
 * operation it belongs to. `body` is the row's stored prose; a thinking row takes its own
 * drop-when-full append.
 */
export interface ClaudeMessageRow {
  readonly toolCallId: string | null;
  readonly pairingRole: "initiation" | "completion" | "unpaired";
  readonly operation: DeliveryOperation | undefined;
  readonly row:
    | LateAppendableRow
    | { readonly type: "assistant.thinking_update"; readonly payload: ThinkingUpdatePayload };
  readonly body: string;
}

/** A tool call Claude Code answered with an error, and the words it sent the model. */
interface ClaudeFailedToolResult {
  readonly toolCallId: string;
  readonly text: string;
}

function contentBlocksOf(frame: Readonly<Record<string, unknown>>): readonly unknown[] {
  const message = frame["message"];
  const content = isPlainObject(message) ? message["content"] : undefined;
  return Array.isArray(content) ? content : [];
}

// A tool result's content is a string or a list of blocks, whose text blocks are joined.
function readToolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) =>
      isPlainObject(block) && typeof block["text"] === "string" ? [block["text"]] : [],
    )
    .join("\n");
}

/**
 * The id of the message an `assistant` frame is a piece of: its `message.id`, shared by every frame
 * of that message, else the frame's own `uuid`, as Claude Code itself keys a message with no id.
 */
export function readClaudeProviderMessageId(
  frame: Readonly<Record<string, unknown>>,
): string | undefined {
  const message = frame["message"];
  return (
    (isPlainObject(message) ? readNonEmptyString(message, "id") : undefined) ??
    readNonEmptyString(frame, "uuid")
  );
}

/**
 * The rows of one `assistant` frame of the lead: each thinking block's summary as
 * `assistant.thinking_update`, each text block as `assistant.message`, both under the message's
 * id, a fresh one where the frame names none, and each tool call as `tool.invoked`, which opens the
 * call in `openToolCalls`.
 */
export function readClaudeAssistantRows(
  frame: Readonly<Record<string, unknown>>,
  run: ClaudeRowRun,
  openToolCalls: Map<string, ClaudeOpenToolCall>,
  nowMs: number,
): ClaudeMessageRow[] {
  const rows: ClaudeMessageRow[] = [];
  const providerMessageId = readClaudeProviderMessageId(frame) ?? mintUuidV7();
  for (const block of contentBlocksOf(frame)) {
    if (!isPlainObject(block)) {
      continue;
    }
    const blockType = block["type"];
    // A redacted block carries no text, so it has no row.
    const thinking = blockType === "thinking" ? block["thinking"] : undefined;
    const text = blockType === "text" ? block["text"] : undefined;
    if (typeof thinking === "string" && thinking !== "") {
      rows.push({
        toolCallId: null,
        pairingRole: "unpaired",
        operation: undefined,
        row: {
          type: "assistant.thinking_update",
          payload: { sessionId: run.sessionId, runId: run.runId, providerMessageId },
        },
        body: thinking,
      });
      continue;
    }
    if (typeof text === "string" && text !== "") {
      rows.push({
        toolCallId: null,
        pairingRole: "unpaired",
        operation: undefined,
        row: {
          type: "assistant.message",
          payload: { sessionId: run.sessionId, runId: run.runId, providerMessageId },
        },
        body: text,
      });
      continue;
    }
    // An advisor call arrives as Claude Code's own server tool call; both are ordinary tool calls.
    if (blockType !== "tool_use" && blockType !== "server_tool_use") {
      continue;
    }
    const toolCallId = readNonEmptyString(block, "id");
    const toolName = readNonEmptyString(block, "name");
    if (toolCallId === undefined || toolName === undefined) {
      continue;
    }
    openToolCalls.set(toolCallId, { toolName, startedAtMs: nowMs });
    rows.push({
      toolCallId,
      pairingRole: "initiation",
      operation: { correlationKey: toolCallId, isOpening: true },
      row: {
        type: "tool.invoked",
        payload: { sessionId: run.sessionId, runId: run.runId, toolName, toolCallId },
      },
      body: JSON.stringify(block["input"] ?? {}),
    });
  }
  return rows;
}

/**
 * The rows of one `user` frame of the lead and the tool calls it answered with an error. A result
 * naming a call the lead never started carries no row, since no tool is named.
 */
interface ClaudeUserFrameReading {
  readonly rows: ClaudeMessageRow[];
  readonly failedResults: ClaudeFailedToolResult[];
}

/**
 * The tool results one `user` frame carries, each as `tool.result` or, when Claude Code marks it
 * an error, `tool.error`, closing its call in `openToolCalls`. A file-changing call's result body
 * is its patch with its counts, in the shape `transcript.patchRead` answers.
 */
export function readClaudeUserRows(
  frame: Readonly<Record<string, unknown>>,
  run: ClaudeRowRun,
  openToolCalls: Map<string, ClaudeOpenToolCall>,
  nowMs: number,
): ClaudeUserFrameReading {
  const rows: ClaudeMessageRow[] = [];
  const failedResults: ClaudeFailedToolResult[] = [];
  const blocks = contentBlocksOf(frame).filter(
    (block): block is Record<string, unknown> =>
      isPlainObject(block) && block["type"] === "tool_result",
  );
  for (const block of blocks) {
    const toolCallId = readNonEmptyString(block, "tool_use_id");
    if (toolCallId === undefined) {
      continue;
    }
    const text = readToolResultText(block["content"]);
    const isError = block["is_error"] === true;
    if (isError) {
      failedResults.push({ toolCallId, text });
    }
    const opened = openToolCalls.get(toolCallId);
    if (opened === undefined) {
      continue;
    }
    openToolCalls.delete(toolCallId);
    const toolName = opened.toolName;
    // Claude Code's structured result rides the frame beside a lone tool result.
    const patchFile =
      !isError && blocks.length === 1 && isClaudeFileChangingTool(toolName)
        ? readClaudePatchFile(frame["tool_use_result"])
        : undefined;
    const patchBody: TranscriptPatchReadResponse | undefined =
      patchFile === undefined ? undefined : { files: [patchFile] };
    rows.push({
      toolCallId,
      pairingRole: "completion",
      operation: { correlationKey: toolCallId, isOpening: false },
      row: {
        type: isError ? "tool.error" : "tool.result",
        payload: {
          sessionId: run.sessionId,
          runId: run.runId,
          toolName,
          toolCallId,
          durationMs: Math.max(0, nowMs - opened.startedAtMs),
        },
      },
      body: patchBody === undefined ? text : JSON.stringify(patchBody),
    });
  }
  return { rows, failedResults };
}
