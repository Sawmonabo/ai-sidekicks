// Session events whose payload this package declares itself: session, repo, workspace and worktree
// lifecycle, event compaction, and assistant and tool activity. Each has an event interface and a
// strict schema.

import { z } from "zod";
import { EVENT_FIELD_MAX_LEN } from "./event-core.js";
import {
  EVENT_ENVELOPE_SEQUENCE_MAX,
  buildCommonShape,
  withEpochStamp,
  type EventEnvelope,
  type SourceEpoch,
  type SourcePosition,
} from "./event-envelope.js";
import { NodeIdSchema, type NodeId } from "./node-id.js";
import { RepoWorkspaceLifecyclePayloadSchema, type RepoWorkspaceLifecyclePayload } from "./repo.js";
import { SessionCreatedPayloadSchema, type SessionCreatedPayload } from "./session-created.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";
import {
  WorktreeCreatedPayloadSchema,
  WorktreeRetiredPayloadSchema,
  type WorktreeCreatedPayload,
  type WorktreeRetiredPayload,
} from "./worktree-events.js";
import { WorktreeLifecyclePayloadSchema, type WorktreeLifecyclePayload } from "./worktree.js";

// session.created: the payload is session-created.ts's.

// Variant interfaces extend the envelope, narrowing `type`, `category` and `payload` to the
// variant's literals. Adding or narrowing an envelope member surfaces as a type error in every
// variant schema annotation, but removing one does not (Zod's output type is covariant), which
// is why the test suite also pins the eleven envelope keys.
/** Emitted when a session is admitted. */
export interface SessionCreatedEvent extends EventEnvelope {
  type: "session.created";
  category: "session_lifecycle";
  payload: SessionCreatedPayload;
}
/** Wire schema for {@link SessionCreatedEvent}. */
export const SessionCreatedEventSchema: z.ZodType<SessionCreatedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("session.created"),
    category: z.literal("session_lifecycle"),
    payload: SessionCreatedPayloadSchema,
  })
  .strict();

// workspace.*: four variants sharing repo.ts's `RepoWorkspaceLifecyclePayloadSchema`, so their
// payload cannot drift between them. The `worktree.*` variants below use the same
// family shape over their own state vocabulary. None is run-scoped (no `runId`), so none takes
// the epoch stamp.

/** Emitted when a workspace's (re)provisioning begins. */
export interface WorkspacePreparingEvent extends EventEnvelope {
  type: "workspace.preparing";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
/** Wire schema for {@link WorkspacePreparingEvent}. */
export const WorkspacePreparingEventSchema: z.ZodType<WorkspacePreparingEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("workspace.preparing"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

/** Emitted when provisioning completes and the execution root is bound. */
export interface WorkspaceReadyEvent extends EventEnvelope {
  type: "workspace.ready";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
/** Wire schema for {@link WorkspaceReadyEvent}. */
export const WorkspaceReadyEventSchema: z.ZodType<WorkspaceReadyEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("workspace.ready"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

/**
 * Emitted when a workspace becomes unavailable: a failed reprovision, or a path that went away
 * after binding. Write runs are blocked until repair.
 */
export interface WorkspaceStaleEvent extends EventEnvelope {
  type: "workspace.stale";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
/** Wire schema for {@link WorkspaceStaleEvent}. */
export const WorkspaceStaleEventSchema: z.ZodType<WorkspaceStaleEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("workspace.stale"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

/** Emitted once per dependent workspace archived by the detach cascade. */
export interface WorkspaceArchivedEvent extends EventEnvelope {
  type: "workspace.archived";
  category: "session_lifecycle";
  payload: RepoWorkspaceLifecyclePayload;
}
/** Wire schema for {@link WorkspaceArchivedEvent}. */
export const WorkspaceArchivedEventSchema: z.ZodType<WorkspaceArchivedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("workspace.archived"),
    category: z.literal("session_lifecycle"),
    payload: RepoWorkspaceLifecyclePayloadSchema,
  })
  .strict();

// worktree.*: five variants. Their payload is the family factory instantiated over
// `WorktreeStateSchema` (`WorktreeLifecyclePayloadSchema` in worktree.ts), so a worktree event
// claiming a workspace state stays a parse error. `worktree.created` and `worktree.retired` add
// the members worktree-events.ts declares. There is no `worktree.failed`: the worktree row's
// `-> failed` transition emits no worktree event, because `workspace.stale` already records the
// failure, and `SessionEventSchema` must keep rejecting it. None is run-scoped, so none takes the
// epoch stamp.

/** Emitted with worktree row creation; carries the kept copy a put-back came from, if any. */
export interface WorktreeCreatedEvent extends EventEnvelope {
  type: "worktree.created";
  category: "session_lifecycle";
  payload: WorktreeCreatedPayload;
}
/** Wire schema for {@link WorktreeCreatedEvent}. */
export const WorktreeCreatedEventSchema: z.ZodType<WorktreeCreatedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.created"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeCreatedPayloadSchema,
  })
  .strict();

/** Emitted on the `creating -> ready` transition: the checkout is bound as an execution root. */
export interface WorktreeReadyEvent extends EventEnvelope {
  type: "worktree.ready";
  category: "session_lifecycle";
  payload: WorktreeLifecyclePayload;
}
/** Wire schema for {@link WorktreeReadyEvent}. */
export const WorktreeReadyEventSchema: z.ZodType<WorktreeReadyEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.ready"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeLifecyclePayloadSchema,
  })
  .strict();

/** Emitted on the `-> dirty` transition: uncommitted work was observed in the checkout. */
export interface WorktreeDirtyEvent extends EventEnvelope {
  type: "worktree.dirty";
  category: "session_lifecycle";
  payload: WorktreeLifecyclePayload;
}
/** Wire schema for {@link WorktreeDirtyEvent}. */
export const WorktreeDirtyEventSchema: z.ZodType<WorktreeDirtyEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.dirty"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeLifecyclePayloadSchema,
  })
  .strict();

/** Emitted on the `-> merged` transition: the worktree's branch has merged back. */
export interface WorktreeMergedEvent extends EventEnvelope {
  type: "worktree.merged";
  category: "session_lifecycle";
  payload: WorktreeLifecyclePayload;
}
/** Wire schema for {@link WorktreeMergedEvent}. */
export const WorktreeMergedEventSchema: z.ZodType<WorktreeMergedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.merged"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeLifecyclePayloadSchema,
  })
  .strict();

/**
 * Emitted on the `-> retired` transition, recorded and evented before any disk mutation; cleanup
 * is asynchronous and idempotent. Carries the kept copy when a discard kept one.
 */
export interface WorktreeRetiredEvent extends EventEnvelope {
  type: "worktree.retired";
  category: "session_lifecycle";
  payload: WorktreeRetiredPayload;
}
/** Wire schema for {@link WorktreeRetiredEvent}. */
export const WorktreeRetiredEventSchema: z.ZodType<WorktreeRetiredEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("worktree.retired"),
    category: z.literal("session_lifecycle"),
    payload: WorktreeRetiredPayloadSchema,
  })
  .strict();

// event.compacted: the purge receipt. Its payload is declared here because the daemon emits the
// row itself. It re-spells `occurredAt` beside the envelope's own, as `session.created`'s payload
// re-spells `sessionId`, rather than deduplicating. The row is a node-level record bound to the
// daemon-scope sentinel `sessionId`; that binding is the emitter's job and the schema does not
// narrow to it, so an `event.compacted` for one session may carry that session's id. It is not
// run-scoped, so it takes no epoch stamp.

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
    message: `A payload sequence value must be at most ${EVENT_ENVELOPE_SEQUENCE_MAX} (Number.MAX_SAFE_INTEGER), the same injectivity ceiling EventEnvelope.sequence takes.`,
  });

// The event_maintenance payload base; `occurredAt` re-spells the envelope's own.
const buildEventMaintenanceBaseShape = () => ({
  nodeId: NodeIdSchema,
  // The batch or pass correlation id: opaque, bounded free-form; no format is fixed.
  operationId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "event_maintenance.operationId"),
  occurredAt: z.iso.datetime({ offset: true }),
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
/** Wire schema for {@link EventCompactedEvent}. */
export const EventCompactedEventSchema: z.ZodType<EventCompactedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("event.compacted"),
    category: z.literal("event_maintenance"),
    payload: EventCompactedPayloadSchema,
  })
  .strict();

// Machine-authored content: `assistant.message`, `assistant.thinking_update`, `tool.invoked`,
// `tool.result` and `tool.error`.
//
// The body is not a payload member. It lives in `session_events.content_payload`, left out of the
// canonical bytes; `payload` carries only its length and whether it was cut. A reader pairs the
// event with the body
// ({@link HydratedSessionEvent}). The schemas are `.strict()`, so a body spliced into `payload`
// fails validation.
//
// Two families, not one schema: the assistant pair has `contentType` and no tool identity; the
// tool trio has a required `toolName` beside optional `toolCallId` and `durationMs`, and no
// `contentType`.
//
// Member ownership splits at the append path. `contentType` is the producer's, which knows the
// media type. The two {@link MachineContentDescriptor} members are the append path's: facts about
// what it stored, determined after the plaintext bound was applied. A producer that pre-carries
// either is refused at the write path.
//
// All five are run-scoped (`runId`), so each takes the epoch stamp.

/**
 * The payload key carrying the body's pre-truncation UTF-8 byte length, so a truncated row still
 * reports how much was dropped.
 */
export const CONTENT_LENGTH_PAYLOAD_KEY = "contentLength" as const;

/**
 * The payload key marking a body stored as a prefix. Present only as `true` and omitted when the
 * stored body is complete, never written as `false`: absence is the completeness signal, and an
 * omitted key keeps a complete row's canonical bytes identical to what they would be without the
 * bound.
 */
export const CONTENT_TRUNCATED_PAYLOAD_KEY = "contentTruncated" as const;

/**
 * The per-row plaintext ceiling for `session_events.content_payload`: 262144 bytes (256 KiB) of
 * UTF-8. The column holds machine-scale text (a tool result is often a file dump or a command's
 * whole stdout), so an over-bound body is truncated at a codepoint boundary, never refused or
 * dropped: refusing the append would lose the turn, and dropping the body would misreport that
 * the turn never happened.
 */
export const CONTENT_PAYLOAD_PLAINTEXT_MAX: number = 262_144;

// A type alias, not an interface: `EventEnvelope.payload` is `Record<string, unknown>`, and
// TypeScript gives an implicit index signature to object-literal types but never to an interface,
// so an interface payload could not satisfy the envelope it extends.
/**
 * The two descriptive members the append path owns, carried by every body-bearing payload. Each
 * is optional: a row with no body (an `assistant.message` whose body the driver could not read,
 * a `tool.invoked` with no arguments) is valid, and requiring them would make its producer invent
 * a length for bytes that do not exist.
 */
export type MachineContentDescriptor = {
  /** Pre-truncation UTF-8 byte length of the body that was stored. */
  contentLength?: number | undefined;
  /** Present as `true` only when the stored body is a prefix; never `false`. */
  contentTruncated?: true | undefined;
};

/** Payload of `assistant.message` and `assistant.thinking_update`. */
export type AssistantOutputPayload = MachineContentDescriptor & {
  sessionId: SessionId;
  runId: string;
  /** Media type of the body, set by the producer and not by the append path. */
  contentType?: string | undefined;
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
  contentLength: z.number().int().nonnegative().optional(),
  // `z.literal(true)`, not `z.boolean()`: a `false` on the wire would canonicalize into bytes a
  // complete row must not have, so omit-never-false is enforced at parse.
  contentTruncated: z.literal(true).optional(),
});

const buildAssistantOutputPayloadShape = () => ({
  sessionId: SessionIdSchema,
  // A bounded free-form guard like `EventEnvelope.id`, not the branded `RunIdSchema` that
  // `usage.model_rerouted` uses.
  runId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "assistant output payload runId"),
  contentType: wireFreeFormString(
    EVENT_FIELD_MAX_LEN,
    "assistant output payload contentType",
  ).optional(),
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
  durationMs: z.number().int().nonnegative().optional(),
  ...buildMachineContentDescriptorShape(),
});

/** Strict payload schema of `assistant.message`, with the epoch stamp. */
export const assistantMessagePayloadSchema: z.ZodType<AssistantMessageEvent["payload"]> =
  withEpochStamp(z.object(buildAssistantOutputPayloadShape()).strict());
/** Strict payload schema of `assistant.thinking_update`, with the epoch stamp. */
export const assistantThinkingUpdatePayloadSchema: z.ZodType<
  AssistantThinkingUpdateEvent["payload"]
> = withEpochStamp(z.object(buildAssistantOutputPayloadShape()).strict());
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
/** Wire schema for {@link AssistantMessageEvent}. */
export const AssistantMessageEventSchema: z.ZodType<AssistantMessageEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("assistant.message"),
    category: z.literal("assistant_output"),
    payload: assistantMessagePayloadSchema,
  })
  .strict();

/** Emitted when the assistant reports a reasoning update; its body is kept apart. */
export interface AssistantThinkingUpdateEvent extends EventEnvelope {
  type: "assistant.thinking_update";
  category: "assistant_output";
  payload: AssistantOutputPayload;
}
/** Wire schema for {@link AssistantThinkingUpdateEvent}. */
export const AssistantThinkingUpdateEventSchema: z.ZodType<AssistantThinkingUpdateEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("assistant.thinking_update"),
    category: z.literal("assistant_output"),
    payload: assistantThinkingUpdatePayloadSchema,
  })
  .strict();

/** Emitted when a tool call starts; its arguments are kept apart from the payload. */
export interface ToolInvokedEvent extends EventEnvelope {
  type: "tool.invoked";
  category: "tool_activity";
  payload: ToolActivityPayload;
}
/** Wire schema for {@link ToolInvokedEvent}. */
export const ToolInvokedEventSchema: z.ZodType<ToolInvokedEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("tool.invoked"),
    category: z.literal("tool_activity"),
    payload: toolInvokedPayloadSchema,
  })
  .strict();

/** Emitted when a tool call returns; its result is kept apart from the payload. */
export interface ToolResultEvent extends EventEnvelope {
  type: "tool.result";
  category: "tool_activity";
  payload: ToolActivityPayload;
}
/** Wire schema for {@link ToolResultEvent}. */
export const ToolResultEventSchema: z.ZodType<ToolResultEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("tool.result"),
    category: z.literal("tool_activity"),
    payload: toolResultPayloadSchema,
  })
  .strict();

/** Emitted when a tool call fails; its error body is kept apart from the payload. */
export interface ToolErrorEvent extends EventEnvelope {
  type: "tool.error";
  category: "tool_activity";
  payload: ToolActivityPayload;
}
/** Wire schema for {@link ToolErrorEvent}. */
export const ToolErrorEventSchema: z.ZodType<ToolErrorEvent> = z
  .object({
    ...buildCommonShape(),
    type: z.literal("tool.error"),
    category: z.literal("tool_activity"),
    payload: toolErrorPayloadSchema,
  })
  .strict();
