// The session directory as a client reads and moves it: the live sessions list and its
// entries, creating a session (where it works and who leads it), converting a chat to a
// project (its shapes in `session/convert.ts`), forking a session, moving its working folder,
// and the `session.*` method table for these verbs and for `session.subscribe`.
//
// The subscribe shapes name the session event union, which imports `session/methods.ts` at load,
// so they cannot live there.
import { z } from "zod";

import {
  AgentDefinitionIdSchema,
  AgentProviderBindingSchema,
  AgentResolvedConfigurationSchema,
  providerTokenSchema,
  type AgentDefinitionId,
  type AgentProviderBinding,
  type AgentResolvedConfiguration,
} from "../agent/definition.js";
import { SessionEventSchema } from "../event/session.js";
import type { SessionEvent } from "../event/variant-types.js";
import { wireFreeFormString, wireUncappedFreeFormString } from "../free-form-string.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";
import { requirePageToRideOneFrame } from "../jsonrpc/page.js";
import { SubscriptionIdSchema, type SubscribeAckResponse } from "../jsonrpc/streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "../method-descriptor.js";
import { DRIVER_TOOL_NAME_MAX_LEN } from "../provider/driver/length-limits.js";
import { ProviderNameSchema, type ProviderName } from "../provider/name.js";
import {
  ExecutionModeSchema,
  RepoMountIdSchema,
  type ExecutionMode,
  type RepoMountId,
} from "../repo/mount.js";
import { WorktreeIdSchema, type WorktreeId } from "../worktree/lifecycle.js";
import {
  SessionConvertRequestSchema,
  SessionConvertResponseSchema,
  type SessionConvertRequest,
  type SessionConvertResponse,
} from "./convert.js";
import { SessionGroupIdSchema, type SessionGroupId } from "./groups.js";
import { EventCursorSchema, SessionIdSchema, type EventCursor, type SessionId } from "./id.js";
import {
  SESSION_NAME_MAX_LEN,
  SessionShapeSchema,
  SessionStateSchema,
  SessionStreamFrameSchema,
  SessionSubscribeRequestSchema,
  SessionSubscribeResponseSchema,
  type SessionShape,
  type SessionState,
  type SessionStreamFrame,
  type SessionSubscribeRequest,
  type SessionSubscribeResponse,
} from "./methods.js";

/**
 * What a session is doing, as the daemon derives it: exactly one of five, and no client
 * invents a sixth. `waiting` is waiting on the person; `failed` is a session that died, kept
 * apart from one that finished (`done`).
 */
export type SessionActivity = "running" | "waiting" | "done" | "failed" | "idle";
/** Parses a {@link SessionActivity}. */
export const SessionActivitySchema: z.ZodType<SessionActivity> = z.enum([
  "running",
  "waiting",
  "done",
  "failed",
  "idle",
]);

/**
 * How often the daemon republishes a quiet running or waiting session's entry.
 */
export const SESSION_ACTIVITY_RENEW_INTERVAL_MS = 15_000;

/**
 * How old a `running` or `waiting` reading may be before a reader stops believing it: three
 * missed renewals, so a daemon that stopped publishing never leaves a row claiming work.
 */
export const SESSION_ACTIVITY_STALE_AFTER_MS = 45_000;

/**
 * The activity a reader shows for an entry at `nowMs`: a `running` or `waiting` reading
 * renewed longer ago than {@link SESSION_ACTIVITY_STALE_AFTER_MS} reads as `idle`. Every other
 * word stands as published; a `failed` session never ages out of being failed.
 */
export function sessionActivityAsOf(
  entry: Pick<SessionListEntry, "activity" | "activityRenewedAt">,
  nowMs: number,
): SessionActivity {
  if (entry.activity !== "running" && entry.activity !== "waiting") {
    return entry.activity;
  }
  const renewedAtMs = Date.parse(entry.activityRenewedAt);
  return nowMs - renewedAtMs > SESSION_ACTIVITY_STALE_AFTER_MS ? "idle" : entry.activity;
}

/**
 * The line a session's row shows in place of its branch or document count while it trades
 * messages with another session: the other session and how many messages the two have traded
 * since the person last wrote in either.
 */
export interface SessionExchange {
  peerSessionId: SessionId;
  peerName: string;
  messageCount: number;
}
const SessionExchangeSchema: z.ZodType<SessionExchange> = z
  .object({
    peerSessionId: SessionIdSchema,
    peerName: wireFreeFormString(SESSION_NAME_MAX_LEN, "SessionExchange.peerName"),
    messageCount: z.number().int().positive(),
  })
  .strict();

/** The group of its project a session sits in, named as the list draws it. */
export interface SessionListGroup {
  groupId: SessionGroupId;
  name: string;
}
const SessionListGroupSchema: z.ZodType<SessionListGroup> = z
  .object({
    groupId: SessionGroupIdSchema,
    name: wireFreeFormString(SESSION_NAME_MAX_LEN, "SessionListGroup.name"),
  })
  .strict();

/**
 * What a list entry carries for its shape: a project's key, branch and group, or a chat's
 * documents. A chat sits in no group.
 */
export type SessionListEntryPlace =
  | {
      shape: "project";
      repoMountId: RepoMountId;
      branch?: string | undefined;
      group?: SessionListGroup | undefined;
    }
  | { shape: "chat"; documentCount: number };

/**
 * One row of the sessions list, everything the row draws from one feed so the list opens no
 * stream per session.
 *
 * - `name` is absent while the session is untitled; the row then shows `firstMessagePreview`,
 *   itself absent before the first message.
 * - A project entry names its project, once known the branch the daemon holds for the session,
 *   so the row costs no git read, and its group while it is in one; a chat entry counts its
 *   documents.
 * - `pinnedAt` is present exactly while the session is pinned; pinned rows sit in the order
 *   they were pinned.
 * - `state` puts archived and closed sessions in the `Archived` group; `activity` is the row's
 *   state word, and `activityRenewedAt` is when the daemon last published it (see
 *   {@link sessionActivityAsOf}).
 * - `lastActivityAt` is the age the row shows.
 */
export type SessionListEntry = SessionListEntryPlace & {
  sessionId: SessionId;
  name?: string | undefined;
  firstMessagePreview?: string | undefined;
  state: SessionState;
  activity: SessionActivity;
  activityRenewedAt: string;
  pinnedAt?: string | undefined;
  muted: boolean;
  exchange?: SessionExchange | undefined;
  lastActivityAt: string;
};
const sessionListEntryCommonFields = {
  sessionId: SessionIdSchema,
  name: wireFreeFormString(SESSION_NAME_MAX_LEN, "SessionListEntry.name").optional(),
  firstMessagePreview: wireFreeFormString(
    SESSION_NAME_MAX_LEN,
    "SessionListEntry.firstMessagePreview",
  ).optional(),
  state: SessionStateSchema,
  activity: SessionActivitySchema,
  activityRenewedAt: isoDateTimeSchema,
  pinnedAt: isoDateTimeSchema.optional(),
  muted: z.boolean(),
  exchange: SessionExchangeSchema.optional(),
  lastActivityAt: isoDateTimeSchema,
};
/** Parses a {@link SessionListEntry}. */
export const SessionListEntrySchema: z.ZodType<SessionListEntry> = z.discriminatedUnion("shape", [
  z
    .object({
      ...sessionListEntryCommonFields,
      shape: z.literal("project"),
      repoMountId: RepoMountIdSchema,
      branch: wireUncappedFreeFormString("SessionListEntry.branch").optional(),
      group: SessionListGroupSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...sessionListEntryCommonFields,
      shape: z.literal("chat"),
      documentCount: countSchema,
    })
    .strict(),
]);

/** `session.list` takes no members: the list is every session on this machine. */
export type SessionListRequest = Record<string, never>;
/** Parses a {@link SessionListRequest}. */
export const SessionListRequestSchema: z.ZodType<SessionListRequest, SessionListRequest> = z
  .object({})
  .strict();

/**
 * `session.list`'s acknowledgment: the subscription, the first page of every session as it
 * stands, and `chatCount`, the chats in the live list (chat sessions not archived, closed or
 * awaiting purge) as the daemon counts them for the Chats header, so no reader counts. While
 * `isComplete` is false the rest of the list follows as `page` changes, each fitting one message,
 * before any other change; the list is whole once a page arrives with `isComplete` true.
 */
export interface SessionListAck extends SubscribeAckResponse {
  readonly sessions: SessionListEntry[];
  readonly chatCount: number;
  readonly isComplete: boolean;
}
/** Parses a {@link SessionListAck}. */
export const SessionListAckSchema: z.ZodType<SessionListAck> = z
  .object({
    subscriptionId: SubscriptionIdSchema,
    sessions: z.array(SessionListEntrySchema),
    chatCount: countSchema,
    isComplete: z.boolean(),
  })
  .strict()
  .superRefine((ack, issueContext) => {
    requirePageToRideOneFrame(ack.sessions, "sessions", issueContext);
  });

/**
 * One change to the list after the acknowledgment: a further page of the opening list, an entry
 * as it now stands, or a session that has left the list, which only a purge does. Each carries
 * `chatCount` as it stands after the change.
 */
export type SessionListChange =
  | { kind: "page"; sessions: SessionListEntry[]; chatCount: number; isComplete: boolean }
  | { kind: "upsert"; entry: SessionListEntry; chatCount: number }
  | { kind: "remove"; sessionId: SessionId; chatCount: number };
/** Parses a {@link SessionListChange}. */
export const SessionListChangeSchema: z.ZodType<SessionListChange> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("page"),
      sessions: z.array(SessionListEntrySchema).min(1),
      chatCount: countSchema,
      isComplete: z.boolean(),
    })
    .strict()
    .superRefine((page, issueContext) => {
      requirePageToRideOneFrame(page.sessions, "sessions", issueContext);
    }),
  z
    .object({ kind: z.literal("upsert"), entry: SessionListEntrySchema, chatCount: countSchema })
    .strict(),
  z
    .object({ kind: z.literal("remove"), sessionId: SessionIdSchema, chatCount: countSchema })
    .strict(),
]);

/**
 * Where a new session works. A chat works in a managed workspace the daemon makes for it in the
 * same step. A project session binds to the project's mount in the same step, working in a
 * worktree of its own (`provisioned-worktree`) or in the project's checkout (`bound-root`).
 */
export type SessionBinding =
  | { kind: "chat" }
  | { kind: "project"; repoMountId: RepoMountId; executionMode: ExecutionMode };
/** Parses a {@link SessionBinding}. */
export const SessionBindingSchema: z.ZodType<SessionBinding, SessionBinding> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("chat") }).strict(),
    z
      .object({
        kind: z.literal("project"),
        repoMountId: RepoMountIdSchema,
        executionMode: ExecutionModeSchema,
      })
      .strict(),
  ],
);

/**
 * The lead as the app chose it: its provider, model and effort, and its output speed where one
 * was picked. It names no account: the daemon resolves that.
 */
export type SessionLead = Omit<AgentProviderBinding, "providerAccountId">;
const SessionLeadSchema: z.ZodType<SessionLead, SessionLead> = z
  .object({
    driverName: ProviderNameSchema,
    modelId: providerTokenSchema("SessionLead.modelId"),
    effort: providerTokenSchema("SessionLead.effort").nullable(),
    outputSpeed: providerTokenSchema("SessionLead.outputSpeed").optional(),
  })
  .strict();

/**
 * What `session.create` takes: where the session works and who leads it.
 *
 * - `lead` is the lead's provider, model and effort, as the app chose them; the daemon resolves
 *   the account.
 * - `leadDefinitionId` names a saved definition the lead runs under; with `lead` beside it,
 *   `lead` is the binding the definition runs on.
 * - At least one of the two is present: a session is born with its lead.
 * - `scratch` asks for the definition's scratch session, which the daemon reuses while one is
 *   open, so it needs `leadDefinitionId` and a chat binding: a scratch session has no repo.
 * - `groupId` files the new session in that group of its project, so it needs a project
 *   binding: a chat sits in no group.
 */
export interface SessionCreateRequest {
  clientIdempotencyKey: string;
  binding: SessionBinding;
  lead?: SessionLead | undefined;
  leadDefinitionId?: AgentDefinitionId | undefined;
  scratch?: true | undefined;
  groupId?: SessionGroupId | undefined;
}
/** Parses a {@link SessionCreateRequest}; a session must name a lead binding or a definition. */
export const SessionCreateRequestSchema: z.ZodType<SessionCreateRequest, SessionCreateRequest> = z
  .object({
    clientIdempotencyKey: z.uuid(),
    binding: SessionBindingSchema,
    lead: SessionLeadSchema.optional(),
    leadDefinitionId: AgentDefinitionIdSchema.optional(),
    scratch: z.literal(true).optional(),
    groupId: SessionGroupIdSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.lead === undefined && request.leadDefinitionId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["lead"],
        message: "A session starts with its lead: name a binding, a definition, or both.",
      });
    }
    if (request.scratch === true) {
      if (request.leadDefinitionId === undefined) {
        context.addIssue({
          code: "custom",
          path: ["leadDefinitionId"],
          message: "A scratch session is led by the definition under test.",
        });
      }
      if (request.binding.kind !== "chat") {
        context.addIssue({
          code: "custom",
          path: ["binding"],
          message: "A scratch session has no repo.",
        });
      }
    }
    if (request.groupId !== undefined && request.binding.kind !== "project") {
      context.addIssue({
        code: "custom",
        path: ["groupId"],
        message: "A chat sits in no group.",
      });
    }
  });

/**
 * What `session.create` answers. `lead` is the binding the daemon resolved for the lead, the
 * account among it. `resolvedConfiguration` is present exactly when the request named a
 * definition: what the lead was started with, so the caller shows what it got rather than
 * re-reading the definition.
 */
export interface SessionCreateResponse {
  sessionId: SessionId;
  shape: SessionShape;
  state: SessionState;
  lead: AgentProviderBinding;
  resolvedConfiguration?: AgentResolvedConfiguration | undefined;
}
/** Parses a {@link SessionCreateResponse}. */
export const SessionCreateResponseSchema: z.ZodType<SessionCreateResponse> = z
  .object({
    sessionId: SessionIdSchema,
    shape: SessionShapeSchema,
    state: SessionStateSchema,
    lead: AgentProviderBindingSchema,
    resolvedConfiguration: AgentResolvedConfigurationSchema.optional(),
  })
  .strict();

/**
 * Fork a session from a message: a new session of the same shape carrying every row up to and
 * including `anchorCursor`. Absent `name` leaves the fork untitled.
 */
export interface SessionForkRequest {
  sessionId: SessionId;
  anchorCursor: EventCursor;
  name?: string | undefined;
  clientIdempotencyKey: string;
}
/** Parses a {@link SessionForkRequest}. */
export const SessionForkRequestSchema: z.ZodType<SessionForkRequest, SessionForkRequest> = z
  .object({
    sessionId: SessionIdSchema,
    anchorCursor: EventCursorSchema,
    name: wireFreeFormString(SESSION_NAME_MAX_LEN, "SessionForkRequest.name").optional(),
    clientIdempotencyKey: z.uuid(),
  })
  .strict();

/**
 * The fork. A project fork lands on a new worktree cut from the parent's current one, named in
 * `worktreeId`; a chat fork gets its own managed workspace and has no worktree.
 */
export type SessionForkResponse =
  | { sessionId: SessionId; shape: "project"; worktreeId: WorktreeId }
  | { sessionId: SessionId; shape: "chat" };
/** Parses a {@link SessionForkResponse}. */
export const SessionForkResponseSchema: z.ZodType<SessionForkResponse> = z.discriminatedUnion(
  "shape",
  [
    z
      .object({
        sessionId: SessionIdSchema,
        shape: z.literal("project"),
        worktreeId: WorktreeIdSchema,
      })
      .strict(),
    z.object({ sessionId: SessionIdSchema, shape: z.literal("chat") }).strict(),
  ],
);

/**
 * Move a project session's working folder to another of its project's worktrees, or with
 * `null` to the project's checkout. Asking for the folder the session is already in cancels a
 * pending move, and a later request replaces a pending one.
 */
export interface SessionSetWorkingFolderRequest {
  sessionId: SessionId;
  worktreeId: WorktreeId | null;
}
/** Parses a {@link SessionSetWorkingFolderRequest}. */
export const SessionSetWorkingFolderRequestSchema: z.ZodType<
  SessionSetWorkingFolderRequest,
  SessionSetWorkingFolderRequest
> = z.object({ sessionId: SessionIdSchema, worktreeId: WorktreeIdSchema.nullable() }).strict();

/**
 * `applied` when the session moved now, or the request cleared a pending move; `pending` when a
 * run was live and the move waits on the session row for the run to end.
 */
export interface SessionSetWorkingFolderResponse {
  sessionId: SessionId;
  disposition: "applied" | "pending";
  worktreeId: WorktreeId | null;
}
/** Parses a {@link SessionSetWorkingFolderResponse}. */
export const SessionSetWorkingFolderResponseSchema: z.ZodType<SessionSetWorkingFolderResponse> = z
  .object({
    sessionId: SessionIdSchema,
    disposition: z.enum(["applied", "pending"]),
    worktreeId: WorktreeIdSchema.nullable(),
  })
  .strict();

/**
 * The terminal pane's held read. The daemon answers once its sessions list or any session's
 * agent list moves past `afterRevision`, or after 10 s with nothing changed.
 */
export interface SessionOverviewReadRequest {
  afterRevision: number;
}
/** Parses a {@link SessionOverviewReadRequest}. */
export const SessionOverviewReadRequestSchema: z.ZodType<
  SessionOverviewReadRequest,
  SessionOverviewReadRequest
> = z.object({ afterRevision: countSchema }).strict();

/** One agent under a session in the terminal pane. */
export interface SessionOverviewAgent {
  name: string;
  provider: ProviderName;
  state: SessionActivity;
}

/** One session in the terminal pane; `title` is absent while the session is untitled. */
export interface SessionOverviewSession {
  id: SessionId;
  title?: string | undefined;
  provider: ProviderName;
  state: SessionActivity;
  agents: SessionOverviewAgent[];
}

/**
 * What the terminal pane draws: every session with its agents and Remote Control's state, read
 * from the projections behind `session.list` and `agent.list`. The next read sends `revision`
 * back as `afterRevision`.
 */
export interface SessionOverviewReadResponse {
  revision: number;
  sessions: SessionOverviewSession[];
  remoteControl: { state: "on" | "off" };
}
/** Parses a {@link SessionOverviewReadResponse}. */
export const SessionOverviewReadResponseSchema: z.ZodType<SessionOverviewReadResponse> = z
  .object({
    revision: countSchema,
    sessions: z.array(
      z
        .object({
          id: SessionIdSchema,
          title: wireFreeFormString(
            SESSION_NAME_MAX_LEN,
            "SessionOverviewSession.title",
          ).optional(),
          provider: ProviderNameSchema,
          state: SessionActivitySchema,
          agents: z.array(
            z
              .object({
                name: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "SessionOverviewAgent.name"),
                provider: ProviderNameSchema,
                state: SessionActivitySchema,
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    remoteControl: z.object({ state: z.enum(["on", "off"]) }).strict(),
  })
  .strict();

/** The session directory's methods, keyed by method name. */
export interface SessionDirectoryMethodDescriptors {
  readonly "session.create": MethodDescriptor<
    "session.create",
    SessionCreateRequest,
    SessionCreateResponse
  >;
  readonly "session.list": SubscriptionMethodDescriptor<
    "session.list",
    SessionListRequest,
    SessionListAck,
    SessionListChange
  >;
  readonly "session.subscribe": SubscriptionMethodDescriptor<
    "session.subscribe",
    SessionSubscribeRequest,
    SessionSubscribeResponse,
    SessionStreamFrame<SessionEvent>
  >;
  readonly "session.convert": MethodDescriptor<
    "session.convert",
    SessionConvertRequest,
    SessionConvertResponse
  >;
  readonly "session.fork": MethodDescriptor<
    "session.fork",
    SessionForkRequest,
    SessionForkResponse
  >;
  readonly "session.setWorkingFolder": MethodDescriptor<
    "session.setWorkingFolder",
    SessionSetWorkingFolderRequest,
    SessionSetWorkingFolderResponse
  >;
  readonly "session.overviewRead": MethodDescriptor<
    "session.overviewRead",
    SessionOverviewReadRequest,
    SessionOverviewReadResponse
  >;
}

/** The session directory methods' wire contract: name, procedure type and schemas. */
export const SESSION_DIRECTORY_METHOD_DESCRIPTORS: SessionDirectoryMethodDescriptors =
  defineMethodDescriptors({
    "session.create": {
      method: "session.create",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionCreateRequestSchema,
      responseSchema: SessionCreateResponseSchema,
    },
    "session.list": {
      method: "session.list",
      procedureType: "subscription",
      mutating: false,
      requestSchema: SessionListRequestSchema,
      responseSchema: SessionListAckSchema,
      emissionSchema: SessionListChangeSchema,
    },
    "session.subscribe": {
      method: "session.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestSchema: SessionSubscribeRequestSchema,
      responseSchema: SessionSubscribeResponseSchema,
      emissionSchema: SessionStreamFrameSchema(SessionEventSchema),
    },
    "session.convert": {
      method: "session.convert",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionConvertRequestSchema,
      responseSchema: SessionConvertResponseSchema,
    },
    "session.fork": {
      method: "session.fork",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionForkRequestSchema,
      responseSchema: SessionForkResponseSchema,
    },
    "session.setWorkingFolder": {
      method: "session.setWorkingFolder",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionSetWorkingFolderRequestSchema,
      responseSchema: SessionSetWorkingFolderResponseSchema,
    },
    "session.overviewRead": {
      method: "session.overviewRead",
      procedureType: "query",
      mutating: false,
      requestSchema: SessionOverviewReadRequestSchema,
      responseSchema: SessionOverviewReadResponseSchema,
    },
  });
