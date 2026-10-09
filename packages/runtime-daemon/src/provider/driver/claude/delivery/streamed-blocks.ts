// The text and thinking Claude Code streams while it writes a response, as `stream_event` frames
// under `--include-partial-messages`: each block's pieces go out as stored pieces of its message,
// and the block's assistant frame, which arrives before the block's stop, sends what the pieces
// have not yet carried. A response Claude Code cut short drops what still waits of the blocks it
// will never finish. The frames are untrusted, so every member is narrowed.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { StreamedText } from "../../streamed-text.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import { readClaudeProviderMessageId, type ClaudeMessageRow } from "./messages.js";

/** The run a streamed block's rows belong to. */
interface ClaudeStreamedRun {
  readonly sessionId: SessionId;
  readonly runId: RunId;
}

/** Sends one block's rows, under the block's key, which names the events they are written as. */
export type ClaudeStreamedRowSink = (rows: readonly ClaudeMessageRow[], blockKey: string) => void;

type ClaudeProseRowType = "assistant.message" | "assistant.thinking_update";

// What one `stream_event` frame says, naming the response by its API message id, the `message.id`
// its assistant frames carry.
type ClaudeStreamEvent =
  | { readonly kind: "block_started"; readonly messageId: string; readonly blockIndex: number }
  | { readonly kind: "block_stopped"; readonly messageId: string }
  | {
      readonly kind: "prose_piece";
      readonly messageId: string;
      readonly blockIndex: number;
      readonly rowType: ClaudeProseRowType;
      readonly piece: string;
    }
  | {
      readonly kind: "message_stopped";
      readonly messageId: string;
      // The index from which the response's blocks will never get an assistant frame.
      readonly abandonedFromIndex: number | undefined;
    };

/** The blocks one session's process is streaming, from their first piece to their turn's end. */
export class ClaudeStreamedBlocks {
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #text = new StreamedText();
  // The block each response is streaming now, by its API message id.
  readonly #streamingBlockByMessage = new Map<string, number>();
  // The streamed blocks of each response no assistant frame has finished yet.
  readonly #unfinishedBlocksByMessage = new Map<string, Set<number>>();
  // The key of the block each assistant frame of the open turn finished, by the frame's uuid.
  readonly #blockKeyByMessageUuid = new Map<string, string>();

  constructor(diagnostics: DriverDiagnosticsEmitter) {
    this.#diagnostics = diagnostics;
  }

  /** Takes one `stream_event` frame of the run's turn; a piece goes out within the interval. */
  observe(
    frame: Readonly<Record<string, unknown>>,
    run: ClaudeStreamedRun,
    send: ClaudeStreamedRowSink,
  ): void {
    const event = readClaudeStreamEvent(frame);
    switch (event?.kind) {
      case undefined:
        return;
      case "block_started":
        this.#streamingBlockByMessage.set(event.messageId, event.blockIndex);
        return;
      case "block_stopped":
        this.#streamingBlockByMessage.delete(event.messageId);
        return;
      case "prose_piece": {
        const key = composeStreamedBlockKey(event.messageId, event.blockIndex);
        const unfinished = this.#unfinishedBlocksByMessage.get(event.messageId) ?? new Set();
        this.#unfinishedBlocksByMessage.set(event.messageId, unfinished.add(event.blockIndex));
        const row = composeProseRow(run, event.messageId, event.rowType);
        this.#text.append(key, run.runId, event.piece, (piece) => {
          send([{ ...row, body: piece }], key);
        });
        return;
      }
      case "message_stopped":
        this.#dropAbandoned(run.sessionId, event.messageId, event.abandonedFromIndex);
        return;
    }
  }

  /**
   * Finishes, with an assistant frame's text or thinking, the block it was streamed as, sending
   * what the pieces have not yet carried. Returns the frame's rows that streamed as no block.
   */
  finish(
    frame: Readonly<Record<string, unknown>>,
    rows: readonly ClaudeMessageRow[],
    send: ClaudeStreamedRowSink,
  ): readonly ClaudeMessageRow[] {
    const messageId = readClaudeProviderMessageId(frame);
    const blockIndex =
      messageId === undefined ? undefined : this.#streamingBlockByMessage.get(messageId);
    if (messageId === undefined || blockIndex === undefined) {
      return rows;
    }
    const key = composeStreamedBlockKey(messageId, blockIndex);
    const messageUuid = readNonEmptyString(frame, "uuid");
    return rows.filter((row) => {
      if (row.row.type !== "assistant.message" && row.row.type !== "assistant.thinking_update") {
        return true;
      }
      this.#unfinishedBlocksByMessage.get(messageId)?.delete(blockIndex);
      if (messageUuid !== undefined) {
        this.#blockKeyByMessageUuid.set(messageUuid, key);
      }
      const isPrefix = this.#text.complete(key, row.body, (piece) => {
        send([{ ...row, body: piece }], key);
      });
      if (!isPrefix) {
        this.#diagnostics.emit({
          provider: CLAUDE_DRIVER_NAME,
          kind: "streamed_text_diverged",
          rawWireType: "assistant",
          dispositionReason:
            "the assistant frame's text does not begin with what streamed of its block, so the " +
            "streamed pieces stand and the frame's text is not written again",
          details: { messageId, blockIndex },
        });
      }
      return false;
    });
  }

  /** The key of the block the open turn's assistant frame `messageUuid` finished, if it streamed. */
  blockKeyFor(messageUuid: string): string | undefined {
    return this.#blockKeyByMessageUuid.get(messageUuid);
  }

  /** Forgets the open turn's assistant frames, as the next turn opens. */
  openTurn(): void {
    this.#blockKeyByMessageUuid.clear();
  }

  /** Sends what still waits of the blocks the run's turn left unfinished, as the turn ends. */
  endTurn(runId: RunId): void {
    this.#text.endTurn(runId);
    this.#streamingBlockByMessage.clear();
    this.#unfinishedBlocksByMessage.clear();
  }

  /** Sends what still waits of every block, as the session's process is gone. */
  endAll(): void {
    this.#text.endAll();
  }

  #dropAbandoned(sessionId: SessionId, messageId: string, from: number | undefined): void {
    const unfinished = this.#unfinishedBlocksByMessage.get(messageId);
    if (from === undefined || unfinished === undefined) {
      return;
    }
    const abandoned = [...unfinished].filter((blockIndex) => blockIndex >= from);
    if (abandoned.length === 0) {
      return;
    }
    const storedBlockCount = abandoned.filter((blockIndex) => {
      unfinished.delete(blockIndex);
      return this.#text.discard(composeStreamedBlockKey(messageId, blockIndex));
    }).length;
    this.#diagnostics.emit({
      provider: CLAUDE_DRIVER_NAME,
      kind: "streamed_blocks_abandoned",
      rawWireType: "stream_event",
      dispositionReason:
        "Claude Code stopped reading a response and will never finish these blocks, so what " +
        "still waited of them is dropped; pieces already stored stay",
      details: { sessionId, messageId, fromBlockIndex: from, storedBlockCount },
    });
  }
}

function readClaudeStreamEvent(
  frame: Readonly<Record<string, unknown>>,
): ClaudeStreamEvent | undefined {
  const messageId = readNonEmptyString(frame, "api_message_id");
  const event = frame["event"];
  if (messageId === undefined || !isPlainObject(event)) {
    return undefined;
  }
  const blockIndex = readBlockIndex(event["index"]);
  switch (event["type"]) {
    case "content_block_start":
      return blockIndex === undefined
        ? undefined
        : { kind: "block_started", messageId, blockIndex };
    case "content_block_stop":
      return { kind: "block_stopped", messageId };
    case "content_block_delta": {
      const delta = event["delta"];
      if (blockIndex === undefined || !isPlainObject(delta)) {
        return undefined;
      }
      const rowType: ClaudeProseRowType | undefined =
        delta["type"] === "text_delta"
          ? "assistant.message"
          : delta["type"] === "thinking_delta"
            ? "assistant.thinking_update"
            : undefined;
      const piece = rowType === "assistant.message" ? delta["text"] : delta["thinking"];
      return rowType === undefined || typeof piece !== "string"
        ? undefined
        : { kind: "prose_piece", messageId, blockIndex, rowType, piece };
    }
    case "message_stop": {
      // Claude Code puts the cut-short blocks beside the event, on the frame itself.
      const abandoned = frame["abandoned_blocks"];
      return {
        kind: "message_stopped",
        messageId,
        abandonedFromIndex: isPlainObject(abandoned)
          ? readBlockIndex(abandoned["from_block_index"])
          : undefined,
      };
    }
    default:
      return undefined;
  }
}

function readBlockIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

// A streamed block's key: its response's API message id and its index in that response.
function composeStreamedBlockKey(messageId: string, blockIndex: number): string {
  return `${messageId}#${String(blockIndex)}`;
}

// A prose row of the response `messageId`, whose body each piece fills in.
function composeProseRow(
  run: ClaudeStreamedRun,
  messageId: string,
  rowType: ClaudeProseRowType,
): ClaudeMessageRow {
  return {
    toolCallId: null,
    pairingRole: "unpaired",
    operation: undefined,
    row: {
      type: rowType,
      payload: { sessionId: run.sessionId, runId: run.runId, providerMessageId: messageId },
    },
    body: "",
  };
}
