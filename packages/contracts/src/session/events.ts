// The payloads of a session's own events: its creation, its lifecycle moves, its renames, its
// marks, its advisor, its output style and its provider's status. The event contract composes
// them into the event union and imports this file at load, so none may import that contract.
import { z } from "zod";

import { AgentDefinitionIdSchema, type AgentDefinitionId } from "../agent/definition.js";
import { AgentListEntrySchema, type AgentListEntry } from "../agent/methods.js";
import { withEpochStamp, type SourceEpoch, type SourcePosition } from "../event/envelope.js";
import { wireFreeFormString } from "../free-form-string.js";
import { isoDateTimeSchema } from "../internal/wire-scalars.js";
import { MACHINE_SETTINGS_NAME_MAX_LEN } from "../machine-settings.js";
import { DRIVER_FAILURE_DETAIL_MAX_LEN } from "../provider/driver/length-limits.js";
import { DRIVER_WIRE_TOKEN_MAX_LEN } from "../provider/driver/methods.js";
import { ProviderNameSchema, type ProviderName } from "../provider/name.js";
import { RunIdSchema, type RunId } from "../run/id.js";
import {
  EventCursorSchema,
  SessionIdSchema,
  UserIdSchema,
  type SessionId,
  type UserId,
} from "./id.js";
import { type EventCursor } from "./event-cursor.js";
import {
  SessionShapeSchema,
  SessionStateSchema,
  type SessionShape,
  type SessionState,
} from "./methods.js";
import { SESSION_NAME_MAX_LEN } from "./name.js";

/** The session a fork was taken from, and the message it was taken at. */
export interface SessionCreatedParent {
  sessionId: SessionId;
  anchorCursor: EventCursor;
}
const SessionCreatedParentSchema: z.ZodType<SessionCreatedParent> = z
  .object({ sessionId: SessionIdSchema, anchorCursor: EventCursorSchema })
  .strict();

/**
 * A session's birth, bringing in its lead as `mainAgent`. `parent` is present exactly on a fork,
 * and `scratchForDefinitionId` names the saved definition a scratch session tries.
 */
export type SessionCreatedPayload = {
  sessionId: SessionId;
  shape: SessionShape;
  mainAgent: AgentListEntry;
  parent?: SessionCreatedParent | undefined;
  scratchForDefinitionId?: AgentDefinitionId | undefined;
  actor?: UserId | undefined;
};
/** Parses a {@link SessionCreatedPayload}. */
export const SessionCreatedPayloadSchema: z.ZodType<SessionCreatedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    shape: SessionShapeSchema,
    mainAgent: AgentListEntrySchema,
    parent: SessionCreatedParentSchema.optional(),
    scratchForDefinitionId: AgentDefinitionIdSchema.optional(),
    actor: UserIdSchema.optional(),
  })
  .strict();

/**
 * The payload of a lifecycle move — `session.activated`, `session.archived`,
 * `session.reactivated`, `session.closed` — naming the state the session left and the one it is
 * in. `actor` is the person who acted, absent when the daemon moved it.
 */
export interface SessionLifecycleChangePayload {
  sessionId: SessionId;
  previousState?: SessionState | undefined;
  newState: SessionState;
  actor?: UserId | undefined;
}
/** Parses a {@link SessionLifecycleChangePayload}. */
export const SessionLifecycleChangePayloadSchema: z.ZodType<SessionLifecycleChangePayload> = z
  .object({
    sessionId: SessionIdSchema,
    previousState: SessionStateSchema.optional(),
    newState: SessionStateSchema,
    actor: UserIdSchema.optional(),
  })
  .strict();

/**
 * Who a rename came from: the person (`user`), the provider renaming its own conversation
 * (`provider`), or the daemon's naming pass after the first exchange (`auto`), which writes only
 * while the session is unnamed, so a name the person typed always wins.
 */
export type SessionRenameOrigin = "user" | "provider" | "auto";
/** Parses a {@link SessionRenameOrigin}. */
export const SessionRenameOriginSchema: z.ZodType<SessionRenameOrigin> = z.enum([
  "user",
  "provider",
  "auto",
]);

/**
 * The `session.renamed` payload: the new name, `null` when the name was cleared, the name it
 * replaced where there was one, and who renamed it. A rename to the current name writes no event.
 */
export interface SessionRenamedPayload {
  sessionId: SessionId;
  name: string | null;
  previousName?: string | undefined;
  origin: SessionRenameOrigin;
  actor?: UserId | undefined;
}
/** Parses a {@link SessionRenamedPayload}. */
export const SessionRenamedPayloadSchema: z.ZodType<SessionRenamedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    name: wireFreeFormString(SESSION_NAME_MAX_LEN, "SessionRenamedPayload.name").nullable(),
    previousName: wireFreeFormString(
      SESSION_NAME_MAX_LEN,
      "SessionRenamedPayload.previousName",
    ).optional(),
    origin: SessionRenameOriginSchema,
    actor: UserIdSchema.optional(),
  })
  .strict();

/**
 * The payload of a session mark set or cleared — `session.pinned`, `session.unpinned`,
 * `session.muted`, `session.unmuted` — with the time it happened. Pinned rows sit in the order
 * they were pinned, and a mute stands until it is cleared: both are rebuilt from these events.
 */
export interface SessionMarkChangePayload {
  sessionId: SessionId;
  at: string;
}
/** Parses a {@link SessionMarkChangePayload}. */
export const SessionMarkChangePayloadSchema: z.ZodType<SessionMarkChangePayload> = z
  .object({ sessionId: SessionIdSchema, at: isoDateTimeSchema })
  .strict();

/**
 * The `session.advisor_changed` payload: a Claude Code session's own advisor, changed by
 * `/advisor` in that session, with the time it happened. `advisorModel` is the session's own
 * setting, which every later process starts with, `null` when the advisor is off;
 * `attachedAdvisorModel` is the advisor Claude Code says it attaches after the change, `null` when
 * none attaches, absent where the build does not report it. The chip shows the attached one.
 */
export interface SessionAdvisorChangedPayload {
  sessionId: SessionId;
  advisorModel: string | null;
  attachedAdvisorModel?: string | null | undefined;
  at: string;
}
/** Parses a {@link SessionAdvisorChangedPayload}. */
export const SessionAdvisorChangedPayloadSchema: z.ZodType<
  SessionAdvisorChangedPayload,
  SessionAdvisorChangedPayload
> = z
  .object({
    sessionId: SessionIdSchema,
    advisorModel: wireFreeFormString(
      MACHINE_SETTINGS_NAME_MAX_LEN,
      "SessionAdvisorChangedPayload.advisorModel",
    ).nullable(),
    attachedAdvisorModel: wireFreeFormString(
      MACHINE_SETTINGS_NAME_MAX_LEN,
      "SessionAdvisorChangedPayload.attachedAdvisorModel",
    )
      .nullable()
      .optional(),
    at: isoDateTimeSchema,
  })
  .strict();

/**
 * The `session.output_style_changed` payload: a Claude Code session's own output style, changed by
 * `/output-style` in that session, with the time it happened.
 */
export interface SessionOutputStyleChangedPayload {
  sessionId: SessionId;
  outputStyle: string;
  at: string;
}
/** Parses a {@link SessionOutputStyleChangedPayload}. */
export const SessionOutputStyleChangedPayloadSchema: z.ZodType<
  SessionOutputStyleChangedPayload,
  SessionOutputStyleChangedPayload
> = z
  .object({
    sessionId: SessionIdSchema,
    outputStyle: wireFreeFormString(
      MACHINE_SETTINGS_NAME_MAX_LEN,
      "SessionOutputStyleChangedPayload.outputStyle",
    ),
    at: isoDateTimeSchema,
  })
  .strict();

/**
 * The `session.provider_status` payload: a coarse status the provider reported for its session,
 * normalized, with display text where it sent some. It records what the provider said and never
 * moves the session's own state. It takes the epoch stamp, which needs `runId`.
 */
export interface SessionProviderStatusPayload {
  sessionId: SessionId;
  runId?: RunId | undefined;
  provider: ProviderName;
  status: string;
  detail?: string | undefined;
  sourceEpoch?: SourceEpoch | undefined;
  sourcePosition?: SourcePosition | undefined;
}
/** Parses a {@link SessionProviderStatusPayload}. */
export const SessionProviderStatusPayloadSchema: z.ZodType<SessionProviderStatusPayload> =
  withEpochStamp(
    z
      .object({
        sessionId: SessionIdSchema,
        runId: RunIdSchema.optional(),
        provider: ProviderNameSchema,
        status: wireFreeFormString(
          DRIVER_WIRE_TOKEN_MAX_LEN,
          "SessionProviderStatusPayload.status",
        ),
        detail: wireFreeFormString(
          DRIVER_FAILURE_DETAIL_MAX_LEN,
          "SessionProviderStatusPayload.detail",
        ).optional(),
      })
      .strict(),
  );
