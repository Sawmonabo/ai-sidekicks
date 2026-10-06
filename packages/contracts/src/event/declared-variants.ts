// Session events whose payload this package declares itself: session, workspace and worktree
// lifecycle, event compaction, and assistant and tool activity. Each has an event interface here;
// `SessionEventSchema` in event/session.ts parses them.

import { z } from "zod";
import { EVENT_FIELD_MAX_LEN } from "./version.js";
import {
  EVENT_ENVELOPE_SEQUENCE_MAX,
  withEpochStamp,
  type EventEnvelope,
  type SourceEpoch,
  type SourcePosition,
} from "./envelope.js";
import { NodeIdSchema, type NodeId } from "../runtime-node/id.js";
import type { RepoWorkspaceLifecyclePayload } from "../repo/mount.js";
import type { SessionCreatedPayload } from "../session/events.js";
import { wireFreeFormString } from "../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";
import type { WorktreeCreatedPayload, WorktreeRetiredPayload } from "../worktree/events.js";
import type { WorktreeLifecyclePayload } from "../worktree/lifecycle.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";
import { MessageOriginSchema, type MessageOrigin } from "../voice.js";

// Each variant interface extends the envelope, narrowing `type`, `category` and `payload` to the
// variant's literals.

/** Emitted when a session is admitted. */
export interface SessionCreatedEvent extends EventEnvelope {
  type: "session.created";
  category: "session_lifecycle";
  payload: SessionCreatedPayload;
}

// The four workspace events share one payload; none is run-scoped, so none takes the epoch stamp.

/** Emitted when a workspace's preparation begins, the first time or again. */
export interface WorkspacePreparingEvent extends EventEnvelope {
  type: "workspace.preparing";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}

/** Emitted when preparation completes and the execution root is bound. */
export interface WorkspaceReadyEvent extends EventEnvelope {
  type: "workspace.ready";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}

/**
 * Emitted when a workspace becomes unavailable: a failed preparation, or a path that went away
 * after binding. Write runs are blocked until repair.
 */
export interface WorkspaceStaleEvent extends EventEnvelope {
  type: "workspace.stale";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}

/** Emitted once per dependent workspace archived by the detach cascade. */
export interface WorkspaceArchivedEvent extends EventEnvelope {
  type: "workspace.archived";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}

// The five worktree events carry worktree states, so one claiming a workspace state fails to
// parse. There is no `worktree.failed`: `workspace.stale` already records that failure. None is
// run-scoped, so none takes the epoch stamp.

/** Emitted with worktree row creation; carries the kept copy a put-back came from, if any. */
export interface WorktreeCreatedEvent extends EventEnvelope {
  type: "worktree.created";
  category: "session_lifecycle";
  payload: WorktreeCreatedPayload;
}

/** Emitted on the `creating -> ready` transition: the checkout is bound as an execution root. */
export interface WorktreeReadyEvent extends EventEnvelope {
  type: "worktree.ready";
  category: "session_lifecycle";
  payload: WorktreeLifecyclePayload;
}

/** Emitted on the `-> dirty` transition: uncommitted work was observed in the checkout. */
export interface WorktreeDirtyEvent extends EventEnvelope {
  type: "worktree.dirty";
  category: "session_lifecycle";
  payload: WorktreeLifecyclePayload;
}

/** Emitted on the `-> merged` transition: the worktree's branch has merged back. */
export interface WorktreeMergedEvent extends EventEnvelope {
  type: "worktree.merged";
  category: "session_lifecycle";
  payload: WorktreeLifecyclePayload;
}

/**
 * Emitted on the `-> retired` transition, recorded and evented before any disk mutation; cleanup
 * is asynchronous and idempotent. Carries the kept copy when a discard kept one.
 */
export interface WorktreeRetiredEvent extends EventEnvelope {
  type: "worktree.retired";
  category: "session_lifecycle";
  payload: WorktreeRetiredPayload;
}

// `event.compacted` is a machine-level record the daemon writes under its own sentinel
// `sessionId`; the schema does not narrow to it. It is not run-scoped, so it takes no epoch stamp.

/**
 * A `session_events.sequence` value carried inside a payload (a range end or an implicated row).
 * It takes the envelope's ceiling, or an endpoint could not name the row it points at and two
 * ranges could disagree about which rows they cover.
 */
const payloadSequenceSchema = z
  .number()
  .int()
  .nonnegative()
  .max(EVENT_ENVELOPE_SEQUENCE_MAX, {
    message:
      `A payload sequence value must be at most ${EVENT_ENVELOPE_SEQUENCE_MAX} ` +
      `(Number.MAX_SAFE_INTEGER), the same injectivity ceiling EventEnvelope.sequence takes.`,
  });

// The event_maintenance payload base; `occurredAt` re-spells the envelope's own.
const buildEventMaintenanceBaseShape = () => ({
  nodeId: NodeIdSchema,
  // The batch or pass correlation id: opaque, bounded free-form; no format is fixed.
  operationId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "event_maintenance.operationId"),
  occurredAt: isoDateTimeSchema,
});

/** One session a deletion removed, with the range of its rows the deletion deleted. */
export interface EventCompactedRemovedSession {
  sessionId: SessionId;
  fromSeq: number;
  toSeq: number;
}
const EventCompactedRemovedSessionSchema: z.ZodType<EventCompactedRemovedSession> = z
  .object({
    sessionId: SessionIdSchema,
    fromSeq: payloadSequenceSchema,
    toSeq: payloadSequenceSchema,
  })
  .strict()
  .refine((removed) => removed.fromSeq <= removed.toSeq, {
    message: "a deleted range starts at or before its end",
    path: ["toSeq"],
  });

/**
 * `event.compacted` — the receipt of one session deletion (`Delete old data`): every session it
 * removed and the range of rows it deleted in each. It is written only when a deletion deleted
 * rows, so it names at least one session.
 */
export type EventCompactedPayload = {
  nodeId: NodeId;
  operationId: string;
  occurredAt: string;
  removedSessions: EventCompactedRemovedSession[];
};
/** Wire schema for {@link EventCompactedPayload}. */
export const EventCompactedPayloadSchema: z.ZodType<EventCompactedPayload> = z
  .object({
    ...buildEventMaintenanceBaseShape(),
    removedSessions: z.array(EventCompactedRemovedSessionSchema).min(1),
  })
  .strict();

/** Emitted once per session deletion that deleted rows. */
export interface EventCompactedEvent extends EventEnvelope {
  type: "event.compacted";
  category: "event_maintenance";
  payload: EventCompactedPayload;
}

// The `assistant.*` and `tool.*` events: the body lives in `session_events.content_payload`,
// outside the canonical bytes, and `payload` carries only its length and whether it was cut; a
// reader pairs the two ({@link HydratedSessionEvent}). The strict payloads refuse a spliced body.
// `contentType` is the producer's; the {@link MachineContentDescriptor} members are the append
// path's, which refuses a producer that pre-carries either. All five take the epoch stamp.

/**
 * The payload key carrying the body's pre-truncation UTF-8 byte length, so a truncated row still
 * reports how much was dropped.
 */
export const CONTENT_LENGTH_PAYLOAD_KEY = "contentLength" as const;

/**
 * The payload key marking a body stored as a prefix. Present only as `true`, never `false`, so a
 * complete row's canonical bytes are what they would be without the bound.
 */
export const CONTENT_TRUNCATED_PAYLOAD_KEY = "contentTruncated" as const;

/**
 * The per-row plaintext ceiling for `session_events.content_payload`, in UTF-8 bytes. A longer
 * body is cut at a codepoint boundary, never refused, so the turn is never lost.
 */
export const CONTENT_PAYLOAD_PLAINTEXT_MAX: number = 262_144;

// A type alias, not an interface: only an object-literal type gets the implicit index signature
// `EventEnvelope.payload` (`Record<string, unknown>`) needs.
/**
 * The two members the append path owns on every body-bearing payload. Each is optional, because a
 * row may have no body.
 */
export type MachineContentDescriptor = {
  /** Pre-truncation UTF-8 byte length of the body that was stored. */
  contentLength?: number | undefined;
  /** Present as `true` only when the stored body is a prefix; never `false`. */
  contentTruncated?: true | undefined;
};

/**
 * Payload of `assistant.message` and `assistant.thinking_update`. `runId` is absent only on a
 * voice call's spoken answer, which comes outside any run and carries `origin: "voice"`.
 */
export type AssistantOutputPayload = MachineContentDescriptor & {
  sessionId: SessionId;
  runId?: string | undefined;
  /** Media type of the body, set by the producer and not by the append path. */
  contentType?: string | undefined;
  /** Present only on the answer a voice call spoke. */
  origin?: MessageOrigin | undefined;
  sourceEpoch?: SourceEpoch | undefined;
  sourcePosition?: SourcePosition | undefined;
};

/** Payload of `tool.invoked`, `tool.result` and `tool.error`. */
export type ToolActivityPayload = MachineContentDescriptor & {
  sessionId: SessionId;
  runId: string;
  /** Required: a tool row with no name cannot be attributed, and the append path cannot add it. */
  toolName: string;
  toolCallId?: string | undefined;
  durationMs?: number | undefined;
  sourceEpoch?: SourceEpoch | undefined;
  sourcePosition?: SourcePosition | undefined;
};

/** The append-path members shared by the five payload schemas and the union. */
export const buildMachineContentDescriptorShape = (): {
  contentLength: z.ZodOptional<z.ZodNumber>;
  contentTruncated: z.ZodOptional<z.ZodLiteral<true>>;
} => ({
  contentLength: countSchema.optional(),
  // `z.literal(true)`, not `z.boolean()`: a `false` on the wire would canonicalize into bytes a
  // complete row must not have, so omit-never-false is enforced at parse.
  contentTruncated: z.literal(true).optional(),
});

const buildAssistantOutputPayloadShape = () => ({
  sessionId: SessionIdSchema,
  // A bounded free-form guard like `EventEnvelope.id`, not the branded `RunIdSchema` that
  // `usage.model_rerouted` uses.
  runId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "assistant output payload runId").optional(),
  contentType: wireFreeFormString(
    EVENT_FIELD_MAX_LEN,
    "assistant output payload contentType",
  ).optional(),
  origin: MessageOriginSchema.optional(),
  ...buildMachineContentDescriptorShape(),
});

const buildToolActivityPayloadShape = () => ({
  sessionId: SessionIdSchema,
  runId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "tool activity payload runId"),
  toolName: wireFreeFormString(EVENT_FIELD_MAX_LEN, "tool activity payload toolName"),
  toolCallId: wireFreeFormString(
    EVENT_FIELD_MAX_LEN,
    "tool activity payload toolCallId",
  ).optional(),
  durationMs: countSchema.optional(),
  ...buildMachineContentDescriptorShape(),
});

// A run carries every assistant row but a voice call's answer, which comes outside any run.
const buildAssistantOutputPayloadSchema = () =>
  withEpochStamp(z.object(buildAssistantOutputPayloadShape()).strict()).refine(
    (payload) => (payload.runId === undefined) === (payload.origin === "voice"),
    {
      path: ["runId"],
      message: "An assistant row carries a run id exactly when it is not a voice call's answer.",
    },
  );

/** Strict payload schema of `assistant.message`, with the epoch stamp. */
export const assistantMessagePayloadSchema: z.ZodType<AssistantMessageEvent["payload"]> =
  buildAssistantOutputPayloadSchema();
/** Strict payload schema of `assistant.thinking_update`, with the epoch stamp. */
export const assistantThinkingUpdatePayloadSchema: z.ZodType<
  AssistantThinkingUpdateEvent["payload"]
> = buildAssistantOutputPayloadSchema();
/** Strict payload schema of `tool.invoked`, with the epoch stamp. */
export const toolInvokedPayloadSchema: z.ZodType<ToolInvokedEvent["payload"]> = withEpochStamp(
  z.object(buildToolActivityPayloadShape()).strict(),
);
/** Strict payload schema of `tool.result`, with the epoch stamp. */
export const toolResultPayloadSchema: z.ZodType<ToolResultEvent["payload"]> = withEpochStamp(
  z.object(buildToolActivityPayloadShape()).strict(),
);
/** Strict payload schema of `tool.error`, with the epoch stamp. */
export const toolErrorPayloadSchema: z.ZodType<ToolErrorEvent["payload"]> = withEpochStamp(
  z.object(buildToolActivityPayloadShape()).strict(),
);

/** Emitted when the assistant produces a message; its body is kept apart from the payload. */
export interface AssistantMessageEvent extends EventEnvelope {
  type: "assistant.message";
  category: "assistant_output";
  payload: AssistantOutputPayload;
}

/** Emitted when the assistant reports a reasoning update; its body is kept apart. */
export interface AssistantThinkingUpdateEvent extends EventEnvelope {
  type: "assistant.thinking_update";
  category: "assistant_output";
  payload: AssistantOutputPayload;
}

/** Emitted when a tool call starts; its arguments are kept apart from the payload. */
export interface ToolInvokedEvent extends EventEnvelope {
  type: "tool.invoked";
  category: "tool_activity";
  payload: ToolActivityPayload;
}

/** Emitted when a tool call returns; its result is kept apart from the payload. */
export interface ToolResultEvent extends EventEnvelope {
  type: "tool.result";
  category: "tool_activity";
  payload: ToolActivityPayload;
}

/** Emitted when a tool call fails; its error body is kept apart from the payload. */
export interface ToolErrorEvent extends EventEnvelope {
  type: "tool.error";
  category: "tool_activity";
  payload: ToolActivityPayload;
}
