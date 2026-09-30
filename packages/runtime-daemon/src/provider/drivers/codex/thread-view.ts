/**
 * Reads a Codex thread as the client returns it, and renders a transcript frame as the responses
 * item the thread accepts back.
 */

import { type SeededTranscriptFrame } from "../../transcript/replay-assertion.js";
import { isPlainObject } from "./record-readers.js";
import { CodexTransportError } from "./session-errors.js";
import { CODEX_THREAD_INJECT_ITEMS_METHOD } from "./provider-commands.js";

interface ThreadView {
  id: string;
  sessionId: string;
  turns: unknown;
}

/**
 * Parses one exported transcript frame, fail-closed. A frame this leg cannot read is refused,
 * never skipped: no `DeclaredLossKind` names a driver-side drop, so a skip would falsify the
 * empty loss list the `applied` arm returns.
 */
export function readRenderedTranscriptFrameForReplay(frame: unknown): SeededTranscriptFrame {
  if (!isPlainObject(frame)) {
    throw new CodexTransportError(
      "A transcript frame handed to the Codex replay leg was not an object.",
      { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
    );
  }
  const position = frame["position"];
  const role = frame["role"];
  const segments = frame["segments"];
  if (typeof position !== "number" || !Number.isInteger(position)) {
    throw new CodexTransportError(
      "A transcript frame handed to the Codex replay leg carried no integer position.",
      { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
    );
  }
  if (role !== "user" && role !== "assistant") {
    throw new CodexTransportError(
      `A transcript frame at position ${String(position)} carried the unrecognized role "${String(role)}".`,
      { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
    );
  }
  if (!Array.isArray(segments)) {
    throw new CodexTransportError(
      `The transcript frame at position ${String(position)} carried no segment list.`,
      { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
    );
  }
  // Only prose-bearing segments form the body (what the post-replay assertion compares);
  // consecutive prose segments join with a blank line.
  const bodyParts: string[] = [];
  for (const segment of segments) {
    if (!isPlainObject(segment)) {
      throw new CodexTransportError(
        `The transcript frame at position ${String(position)} carried a segment that was not an object.`,
        { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
      );
    }
    const kind = segment["kind"];
    if (kind === "text" || kind === "reasoning") {
      const text = segment["text"];
      if (typeof text !== "string") {
        throw new CodexTransportError(
          `A "${String(kind)}" segment of the transcript frame at position ${String(position)} carried no text.`,
          { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
        );
      }
      if (text.length > 0) {
        bodyParts.push(text);
      }
      continue;
    }
    if (kind === "tool_call" || kind === "tool_result") {
      continue;
    }
    // An unrecognized kind refuses, so a kind added to the canonical union fails on its first
    // use.
    throw new CodexTransportError(
      `The transcript frame at position ${String(position)} carried an unsupported segment kind "${String(kind)}"; refusing to seed a frame this driver cannot represent.`,
      { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
    );
  }
  return { position, role, text: bodyParts.join("\n\n") };
}

/**
 * Builds the Responses-API message item for one frame: `input_text` for a user turn,
 * `output_text` for an assistant one. It mints no id, timestamp or author, which a later export
 * could not map.
 */
export function codexResponsesItemForFrame(frame: SeededTranscriptFrame): Record<string, unknown> {
  const contentType: string = frame.role === "user" ? "input_text" : "output_text";
  return {
    type: "message",
    role: frame.role === "user" ? "user" : "assistant",
    content: [{ type: contentType, text: frame.text }],
  };
}

/** Reads the thread from a thread response, throwing a transport error when it carries none. */
export function readThread(response: unknown, method: string): ThreadView {
  const record = isPlainObject(response) ? response : {};
  const thread = record["thread"];
  // The shared guard also refuses an array, whose `["id"]` would read `undefined`.
  if (!isPlainObject(thread)) {
    throw new CodexTransportError(`The Codex app-server "${method}" response carried no thread.`, {
      method,
    });
  }
  const id = thread["id"];
  const sessionId = thread["sessionId"];
  if (typeof id !== "string" || id.length === 0 || typeof sessionId !== "string") {
    throw new CodexTransportError(
      `The Codex app-server "${method}" response carried an unusable thread identity.`,
      { method },
    );
  }
  return { id, sessionId, turns: thread["turns"] };
}

/**
 * Reads the ordered turn ids out of a `Thread.turns` array. Total, not throwing: the list is a
 * bookkeeping seed. Non-string and empty entries are skipped, since a placeholder would shift
 * every later ordinal onto the wrong turn.
 */
export function readThreadTurnIds(turns: unknown): string[] {
  if (!Array.isArray(turns)) {
    return [];
  }
  const turnIds: string[] = [];
  for (const turn of turns) {
    const id = isPlainObject(turn) ? turn["id"] : undefined;
    if (typeof id === "string" && id.length > 0) {
      turnIds.push(id);
    }
  }
  return turnIds;
}

/**
 * Reads the turn a `turn/steer` acknowledgement named, or `null`. Total, unlike `readTurnId`: an
 * unreadable ack is an acknowledgement with no evidence, graded degraded, not a transport fault.
 * It is the flat `{ turnId }`, not `turn/start`'s `{ turn: { id } }`.
 */
export function readSteeredTurnId(response: unknown): string | null {
  const record = isPlainObject(response) ? response : {};
  const turnId = record["turnId"];
  return typeof turnId === "string" && turnId.length > 0 ? turnId : null;
}

/** Reads the turn id from a turn response, throwing a transport error when it carries none. */
export function readTurnId(response: unknown, method: string): string {
  const record = isPlainObject(response) ? response : {};
  const turn = record["turn"];
  const turnRecord = isPlainObject(turn) ? turn : {};
  const id = turnRecord["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new CodexTransportError(`The Codex app-server "${method}" response carried no turn id.`, {
      method,
    });
  }
  return id;
}
