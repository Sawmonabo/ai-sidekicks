// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The payloads of the session events this module declares itself: event compaction and agent and tool activity.

import type { MachineId } from "../machine/id.js";
import type { ToolCallId } from "../provider/tool-call.js";
import type { RunId } from "../run/id.js";
import type { SessionId } from "../session/id.js";
import type { TranscriptOmittedPatch } from "../transcript/row.js";
import type { EventOccurredAt, SourceEpoch, SourcePosition } from "./envelope.js";

/** The payload key carrying the stored body's UTF-8 byte length. */
export const CONTENT_LENGTH_PAYLOAD_KEY = "contentLength" as const;

/** The payload key naming the stored body's encoding, present only on a compressed body. */
export const CONTENT_ENCODING_PAYLOAD_KEY = "contentEncoding" as const;

/**
 * How a stored body's bytes are encoded when they are not its UTF-8 as it is: a body of 1 KiB or
 * more is compressed, and its payload names the encoding so a reader decodes it.
 */
export type ContentEncoding = "zstd";
/**
 * The payload of `agent.message.sent` and `agent.thinking.updated`: a run's row, or a voice
 * call's spoken answer, which alone names no run.
 */
export type AgentOutputPayload =
  | {
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The provider's own id of the message this piece belongs to, the same on every
       * piece, so a reader can rejoin a message the wire delivered in pieces.
       */
      providerMessageId: string;
      /**
       * The body's media type, set by the producer and never by the append path.
       */
      contentType?: string;
      /**
       * The run the row belongs to.
       */
      runId: RunId;
      /**
       * The content block of its provider message the piece belongs to; present on every run's
       * piece.
       */
      providerBlock?: ProviderBlock;
      /**
       * Never present: only a voice call's answer carries an origin.
       */
      origin?: never;
      /**
       * The execution epoch a late row is attributed to; comes with `sourcePosition`.
       */
      sourceEpoch?: SourceEpoch;
      /**
       * The run position the row occupies within its epoch; comes with `sourceEpoch`.
       */
      sourcePosition?: SourcePosition;
      /**
       * The stored body's UTF-8 byte length.
       */
      contentLength?: number;
      /**
       * How the stored body is encoded, present only when it is compressed.
       */
      contentEncoding?: ContentEncoding;
    }
  | {
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The provider's own id of the message this piece belongs to, the same on every
       * piece, so a reader can rejoin a message the wire delivered in pieces.
       */
      providerMessageId: string;
      /**
       * The body's media type, set by the producer and never by the append path.
       */
      contentType?: string;
      /**
       * Always `voice`.
       */
      origin: "voice";
      /**
       * Never present: a voice call's answer comes outside any run.
       */
      runId?: never;
      /**
       * Never present: a spoken answer lands whole.
       */
      providerBlock?: never;
      /**
       * Never present: the stamp is run-local.
       */
      sourceEpoch?: never;
      /**
       * Never present: the stamp is run-local.
       */
      sourcePosition?: never;
      /**
       * The stored body's UTF-8 byte length.
       */
      contentLength?: number;
      /**
       * How the stored body is encoded, present only when it is compressed.
       */
      contentEncoding?: ContentEncoding;
    };
/**
 * Why a tool call ended with no result.
 */
export type ToolCallEndCause = "daemonRestart" | "daemonStop" | "processExit" | "stopped";

/**
 * One session a deletion removed, with the range of its rows the deletion deleted. Each end is a
 * `sequence` value and takes the envelope's ceiling, so it names the row it points at.
 */
export interface SessionEventCompactedRemovedSession {
  /**
   * The session removed.
   */
  sessionId: SessionId;
  /**
   * The first sequence deleted.
   */
  fromSeq: number;
  /**
   * The last sequence deleted; at or after `fromSeq`.
   */
  toSeq: number;
}
/**
 * The `session.event.compacted` payload: one receipt per removed session, committed in the
 * transaction that deletes its rows, naming that session and the range of rows deleted. It is
 * written only when the session had rows. The daemon writes it under its own sentinel session.
 */
export interface SessionEventCompactedPayload {
  /**
   * The machine whose daemon ran the deletion.
   */
  machineId: MachineId;
  /**
   * The deletion's correlation id: opaque, with no fixed format.
   */
  operationId: string;
  /**
   * When the deletion ran; the envelope's own instant, repeated in the payload.
   */
  occurredAt: EventOccurredAt;
  /**
   * Every session removed, with its deleted range.
   *
   * @minItems 1
   */
  removedSessions: [SessionEventCompactedRemovedSession, ...SessionEventCompactedRemovedSession[]];
}
/**
 * Which content block of a provider's message a piece belongs to: a reply sends its text, its
 * reasoning and its tool calls as blocks of one message, and a retried response may reuse the
 * message's id. Pieces join one row only when their message and block are the same.
 */
export interface ProviderBlock {
  /**
   * The block's index within its message, as the provider numbers it.
   */
  index: number;
  /**
   * Which response under the message's id the block belongs to, from 1.
   */
  attempt: number;
}
/**
 * An agent row of a run: every agent row but a voice call's spoken answer. It takes
 * the epoch stamp.
 */
export interface RunAgentOutputPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The provider's own id of the message this piece belongs to, the same on every
   * piece, so a reader can rejoin a message the wire delivered in pieces.
   */
  providerMessageId: string;
  /**
   * The body's media type, set by the producer and never by the append path.
   */
  contentType?: string;
  /**
   * The run the row belongs to.
   */
  runId: RunId;
  /**
   * The content block of its provider message the piece belongs to; present on every run's
   * piece.
   */
  providerBlock?: ProviderBlock;
  /**
   * Never present: only a voice call's answer carries an origin.
   */
  origin?: never;
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
  /**
   * The stored body's UTF-8 byte length.
   */
  contentLength?: number;
  /**
   * How the stored body is encoded, present only when it is compressed.
   */
  contentEncoding?: ContentEncoding;
}
/**
 * A voice call's spoken answer, which comes outside any run, so it names no run and takes no
 * epoch stamp.
 */
export interface VoiceAgentOutputPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The provider's own id of the message this piece belongs to, the same on every
   * piece, so a reader can rejoin a message the wire delivered in pieces.
   */
  providerMessageId: string;
  /**
   * The body's media type, set by the producer and never by the append path.
   */
  contentType?: string;
  /**
   * Always `voice`.
   */
  origin: "voice";
  /**
   * Never present: a voice call's answer comes outside any run.
   */
  runId?: never;
  /**
   * Never present: a spoken answer lands whole.
   */
  providerBlock?: never;
  /**
   * Never present: the stamp is run-local.
   */
  sourceEpoch?: never;
  /**
   * Never present: the stamp is run-local.
   */
  sourcePosition?: never;
  /**
   * The stored body's UTF-8 byte length.
   */
  contentLength?: number;
  /**
   * How the stored body is encoded, present only when it is compressed.
   */
  contentEncoding?: ContentEncoding;
}
/**
 * The payload of `agent.toolCall.invoked` and `agent.toolCall.completed`; the call's
 * arguments or result body is kept apart from it. It takes the epoch stamp.
 */
export interface ToolActivityPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run the call belongs to.
   */
  runId: RunId;
  /**
   * The tool's name; required, since a row with no name cannot be attributed and
   * the append path cannot add it.
   */
  toolName: string;
  /**
   * The provider's id of the call.
   */
  toolCallId?: ToolCallId;
  /**
   * How long the call took, in milliseconds.
   */
  durationMs?: number;
  /**
   * On a completion whose body holds its file patches, every file in the body's
   * order with its patch's UTF-8 size, so a row whose body is too large to travel
   * still names them; set by the producer. A body naming files is stored in bounded
   * parts of each file, which the patch read pages; an empty list names none, and
   * its body is stored as any other.
   */
  omittedPatches?: TranscriptOmittedPatch[];
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
  /**
   * The stored body's UTF-8 byte length.
   */
  contentLength?: number;
  /**
   * How the stored body is encoded, present only when it is compressed.
   */
  contentEncoding?: ContentEncoding;
}
/**
 * The payload of `agent.toolCall.failed`, whose error body is kept apart from it; `endCause`
 * is present only when the call ended with no result, and names why. A row with no body reads
 * its cause's label (`Stopped`, `Process exited`, `Service restarted`, `Service stopped`); any
 * body is the provider's own reason, never the task's name.
 */
export interface ToolCallFailedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run the call belongs to.
   */
  runId: RunId;
  /**
   * The tool's name; required, since a row with no name cannot be attributed and
   * the append path cannot add it.
   */
  toolName: string;
  /**
   * The provider's id of the call.
   */
  toolCallId?: ToolCallId;
  /**
   * How long the call took, in milliseconds.
   */
  durationMs?: number;
  /**
   * On a completion whose body holds its file patches, every file in the body's
   * order with its patch's UTF-8 size, so a row whose body is too large to travel
   * still names them; set by the producer. A body naming files is stored in bounded
   * parts of each file, which the patch read pages; an empty list names none, and
   * its body is stored as any other.
   */
  omittedPatches?: TranscriptOmittedPatch[];
  /**
   * Why the call ended with no result; absent when the call failed with a result.
   */
  endCause?: ToolCallEndCause;
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
  /**
   * The stored body's UTF-8 byte length.
   */
  contentLength?: number;
  /**
   * How the stored body is encoded, present only when it is compressed.
   */
  contentEncoding?: ContentEncoding;
}
/**
 * The payload of `agent.toolCall.backgrounded`: the provider moved the call to the background
 * and answered the model with a stand-in naming its task, which is the row's body.
 */
export interface ToolCallBackgroundedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run the call belongs to.
   */
  runId: RunId;
  /**
   * The tool's name; required, since a row with no name cannot be attributed and
   * the append path cannot add it.
   */
  toolName: string;
  /**
   * The provider's id of the call.
   */
  toolCallId: ToolCallId;
  /**
   * The provider's id of the background task the call became.
   */
  taskId: string;
  /**
   * Whether the task outlives a restart of the background service.
   */
  survivesRestart: boolean;
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
  /**
   * The stored body's UTF-8 byte length.
   */
  contentLength?: number;
  /**
   * How the stored body is encoded, present only when it is compressed.
   */
  contentEncoding?: ContentEncoding;
}

export {
  validateAgentOutputPayload,
  validateContentEncoding,
  validateProviderBlock,
  validateSessionEventCompactedPayload,
  validateSessionEventCompactedRemovedSession,
  validateToolActivityPayload,
  validateToolCallBackgroundedPayload,
  validateToolCallEndCause,
  validateToolCallFailedPayload,
} from "../checks/event/declared-variants.js";
