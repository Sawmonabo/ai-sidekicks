// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The session directory as a client reads and moves it: the live sessions list, creating, converting and forking a session, moving its working folder, and the terminal pane's overview.

import type { AgentProviderBinding } from "../agent/definition.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse, SubscriptionId } from "../jsonrpc/streaming.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { Place } from "../place.js";
import type { ProjectId } from "../project.js";
import type { ProviderOptionSetting } from "../provider/declaration.js";
import type { ProviderId } from "../provider/id.js";
import type { ExecutionMode } from "../repo/mount.js";
import type { WorktreeId } from "../worktree/lifecycle.js";
import type { SessionConvertRequest, SessionConvertResponse } from "./convert.js";
import type { SessionGroupId } from "./groups.js";
import type { EventCursor, SessionId } from "./id.js";
import type {
  SessionEventSubscribeRequest,
  SessionShape,
  SessionState,
  SessionStreamFrame,
} from "./methods.js";

/**
 * How old a `running` or `waiting` reading may be before a reader stops believing it: three
 * missed renewals, so a daemon that stopped publishing never leaves a row claiming work.
 */
export const SESSION_ACTIVITY_STALE_AFTER_MS = 45000 as const;

/**
 * What a session is doing, as the daemon derives it: exactly one of five, and no client invents a
 * sixth. `waiting` is waiting on the person; `failed` is a session that died, kept apart from one
 * that finished (`done`).
 */
export type SessionActivity = "running" | "waiting" | "done" | "failed" | "idle";
/**
 * One row of the sessions list, everything the row draws from one feed so the list opens no
 * stream per session, split on `shape`.
 */
export type SessionListEntry =
  | {
      shape: "project";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * Its name; absent while untitled, when the row shows `firstMessagePreview`.
       */
      name?: string;
      /**
       * The first message's opening; absent before the first message.
       */
      firstMessagePreview?: string;
      /**
       * Its lifecycle state; archived and closed sessions sit in the `Archived` group.
       */
      state: SessionState;
      /**
       * The row's state word.
       */
      activity: SessionActivity;
      /**
       * When the daemon last published `activity`.
       */
      activityRenewedAt: WireInstant;
      /**
       * Present exactly while the session is pinned; pinned rows sit in pin order.
       */
      pinnedAt?: WireInstant;
      /**
       * Whether the person muted the session's notifications.
       */
      muted: boolean;
      /**
       * Present while the session trades messages with another.
       */
      exchange?: SessionExchange;
      /**
       * The age the row shows.
       */
      lastActivityAt: WireInstant;
      /**
       * The project.
       */
      projectId: ProjectId;
      /**
       * The branch the daemon holds for the session, so the row costs no git read.
       */
      branch?: string;
      /**
       * The group it sits in.
       */
      group?: SessionListGroup;
    }
  | {
      shape: "chat";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * Its name; absent while untitled, when the row shows `firstMessagePreview`.
       */
      name?: string;
      /**
       * The first message's opening; absent before the first message.
       */
      firstMessagePreview?: string;
      /**
       * Its lifecycle state; archived and closed sessions sit in the `Archived` group.
       */
      state: SessionState;
      /**
       * The row's state word.
       */
      activity: SessionActivity;
      /**
       * When the daemon last published `activity`.
       */
      activityRenewedAt: WireInstant;
      /**
       * Present exactly while the session is pinned; pinned rows sit in pin order.
       */
      pinnedAt?: WireInstant;
      /**
       * Whether the person muted the session's notifications.
       */
      muted: boolean;
      /**
       * Present while the session trades messages with another.
       */
      exchange?: SessionExchange;
      /**
       * The age the row shows.
       */
      lastActivityAt: WireInstant;
      /**
       * The files in the chat's folder; absent while the folder is being made.
       */
      documentCount?: number;
    };
/**
 * One change to the list after the acknowledgment, each carrying `chatCount` as it stands after
 * the change.
 */
export type SessionListChange =
  | {
      kind: "page";
      /**
       * The sessions, at least one.
       *
       * @minItems 1
       */
      sessions: [SessionListEntry, ...SessionListEntry[]];
      /**
       * The chats in the live list.
       */
      chatCount: number;
      /**
       * Whether the list is now whole.
       */
      isComplete: boolean;
    }
  | {
      kind: "upsert";
      /**
       * The entry.
       */
      entry: SessionListEntry;
      /**
       * The chats in the live list.
       */
      chatCount: number;
    }
  | {
      kind: "remove";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The chats in the live list.
       */
      chatCount: number;
    };
/**
 * Where a new session works, split on `kind`.
 */
export type SessionBinding = SessionChatBinding | SessionProjectBinding;
/**
 * What `session.create` takes: where the session works and who leads it. Only a project session
 * is filed in a group.
 */
export type SessionCreateRequest =
  | {
      /**
       * The key that makes a repeated create one session.
       */
      clientIdempotencyKey: string;
      /**
       * The project's mount.
       */
      binding: SessionProjectBinding;
      /**
       * The lead, as the app chose it; a session is born with its lead.
       */
      lead: SessionLead;
      /**
       * The group of its project to file the session in.
       */
      groupId?: SessionGroupId;
    }
  | {
      /**
       * The key that makes a repeated create one session.
       */
      clientIdempotencyKey: string;
      /**
       * The managed workspace.
       */
      binding: SessionChatBinding;
      /**
       * The lead, as the app chose it; a session is born with its lead.
       */
      lead: SessionLead;
      /**
       * Never present: a chat sits in no group.
       */
      groupId?: never;
    };
/**
 * The fork. A project fork lands on a new worktree cut from the parent's current one; a chat fork
 * gets its own managed workspace and has no worktree.
 */
export type SessionForkResponse =
  | {
      shape: "project";
      /**
       * The fork.
       */
      sessionId: SessionId;
      /**
       * Its worktree.
       */
      worktreeId: WorktreeId;
    }
  | {
      shape: "chat";
      /**
       * The fork.
       */
      sessionId: SessionId;
    };
/**
 * When a working-folder move takes effect.
 */
export type SessionWorkingFolderDisposition = "applied" | "pending" | "dropped";
/**
 * Whether Remote Control is on.
 */
export type RemoteControlState = "on" | "off";

/**
 * The line a session's row shows in place of its branch or document count while it trades
 * messages with another session: the other session and how many messages the two have traded
 * since the person last wrote in either.
 */
export interface SessionExchange {
  /**
   * The other session.
   */
  peerSessionId: SessionId;
  /**
   * Its name.
   */
  peerName: string;
  /**
   * The messages traded.
   */
  messageCount: number;
}
/**
 * The group of its project a session sits in, named as the list draws it.
 */
export interface SessionListGroup {
  /**
   * The group.
   */
  groupId: SessionGroupId;
  /**
   * Its name.
   */
  name: string;
}
/**
 * `session.subscribe`'s acknowledgment: the subscription, the first page of every session as it
 * stands, and `chatCount`, the chats in the live list as the daemon counts them, so no reader
 * counts. While `isComplete` is false the rest of the list follows as `page` changes, before any
 * other change.
 */
export interface SessionSubscribeResponse {
  /**
   * The subscription.
   */
  subscriptionId: SubscriptionId;
  /**
   * The first page of sessions.
   */
  sessions: SessionListEntry[];
  /**
   * The chats in the live list.
   */
  chatCount: number;
  /**
   * Whether the list is whole.
   */
  isComplete: boolean;
}
/**
 * A chat works in a managed workspace the daemon makes for it in the same step.
 */
export interface SessionChatBinding {
  /**
   * `chat`.
   */
  kind: "chat";
}
/**
 * A project session binds to the project's mount in the same step, working in a worktree of its
 * own (`provisionedWorktree`) or in the project's checkout (`boundRoot`).
 */
export interface SessionProjectBinding {
  /**
   * `project`.
   */
  kind: "project";
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * Where in it the session works.
   */
  executionMode: ExecutionMode;
}
/**
 * The lead as the app chose it: its provider, model and effort, and its output speed where one
 * was picked. It names no account: the daemon resolves that.
 */
export interface SessionLead {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * The model.
   */
  modelId: string;
  /**
   * The effort, or `null` for the driver's default; checked when a run resolves.
   */
  effort: string | null;
  /**
   * The output speed, where one was picked; a saved definition leaves it absent.
   */
  outputSpeed?: string;
  /**
   * The values of the session options the driver declares, where any was set; an option
   * left out keeps the provider's own value, and a saved definition leaves it absent.
   *
   * @minItems 1
   */
  options?: [ProviderOptionSetting, ...ProviderOptionSetting[]];
  /**
   * The larger window chosen, in tokens, recorded when picked and sent on every resume
   * and turn; absent is the model's default window.
   */
  largerWindow?: number;
}
/**
 * What `session.create` answers. `lead` is the binding the daemon resolved for the lead, the
 * account among it; `place` is where the session runs, its project's place, or for a chat the
 * place its provider is installed in.
 */
export interface SessionCreateResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Its shape.
   */
  shape: SessionShape;
  /**
   * Its state.
   */
  state: SessionState;
  /**
   * Where it runs, written at its creation and never changed; absent on macOS and Linux.
   */
  place?: Place;
  /**
   * The lead's resolved binding.
   */
  lead: AgentProviderBinding;
}
/**
 * Forks a session from a message: a new session of the same shape carrying every row up to and
 * including `anchorCursor`. Absent `name` leaves the fork untitled.
 */
export interface SessionForkRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The last message the fork carries.
   */
  anchorCursor: EventCursor;
  /**
   * The fork's name.
   */
  name?: string;
  /**
   * The key that makes a repeated fork one fork.
   */
  clientIdempotencyKey: string;
}
/**
 * Moves a project session's working folder to `path`: the folder of any worktree git lists for the
 * project's repository, or the repository's own checkout. Asking for the folder the session is
 * already in cancels a pending move, and a later request replaces a pending one.
 */
export interface SessionWorkingFolderUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The folder.
   */
  path: string;
}
/**
 * The `session.workingFolder.update` result.
 */
export interface SessionWorkingFolderUpdateResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * When the move takes effect.
   */
  disposition: SessionWorkingFolderDisposition;
  /**
   * The folder.
   */
  path: string;
}
/**
 * The terminal pane's held read. The daemon answers once its sessions list or any session's agent
 * list moves past `afterRevision`, or after 10 s with nothing changed.
 */
export interface SessionOverviewReadRequest {
  /**
   * The revision the pane last drew.
   */
  afterRevision: number;
}
/**
 * One agent under a session in the terminal pane.
 */
export interface SessionOverviewAgent {
  /**
   * The agent's name.
   */
  name: string;
  /**
   * Its provider.
   */
  provider: ProviderId;
  /**
   * What it is doing.
   */
  state: SessionActivity;
}
/**
 * One session in the terminal pane; `title` is absent while the session is untitled.
 */
export interface SessionOverviewSession {
  /**
   * The session.
   */
  id: SessionId;
  /**
   * Its title.
   */
  title?: string;
  /**
   * Its lead's provider.
   */
  provider: ProviderId;
  /**
   * What it is doing.
   */
  state: SessionActivity;
  /**
   * Its agents.
   */
  agents: SessionOverviewAgent[];
}
/**
 * What the terminal pane draws: every session with its agents and Remote Control's state, read
 * from the projections behind `session.subscribe` and `agent.subscribe`. The next read sends
 * `revision` back as `afterRevision`.
 */
export interface SessionOverviewReadResponse {
  /**
   * The revision drawn.
   */
  revision: number;
  /**
   * The sessions.
   */
  sessions: SessionOverviewSession[];
  /**
   * Remote Control.
   */
  remoteControl: {
    /**
     * Its state.
     */
    state: RemoteControlState;
  };
}

/** The methods of {@link SESSION_DIRECTORY_METHOD_DESCRIPTORS}, each with its kind. */
export interface SessionDirectoryMethodDescriptors {
  readonly "session.create": {
    readonly method: "session.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "session.subscribe": {
    readonly method: "session.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "session.event.subscribe": {
    readonly method: "session.event.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "session.convert": {
    readonly method: "session.convert";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "session.fork": {
    readonly method: "session.fork";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "session.workingFolder.update": {
    readonly method: "session.workingFolder.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "session.overview.read": {
    readonly method: "session.overview.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link SESSION_DIRECTORY_METHOD_DESCRIPTORS}. */
export interface SessionDirectoryMethodTypes {
  readonly "session.create": {
    readonly params: SessionCreateRequest;
    readonly result: SessionCreateResponse;
  };
  readonly "session.subscribe": {
    readonly params: EmptyPayload;
    readonly result: SessionSubscribeResponse;
    readonly emission: SessionListChange;
  };
  readonly "session.event.subscribe": {
    readonly params: SessionEventSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: SessionStreamFrame;
  };
  readonly "session.convert": {
    readonly params: SessionConvertRequest;
    readonly result: SessionConvertResponse;
  };
  readonly "session.fork": {
    readonly params: SessionForkRequest;
    readonly result: SessionForkResponse;
  };
  readonly "session.workingFolder.update": {
    readonly params: SessionWorkingFolderUpdateRequest;
    readonly result: SessionWorkingFolderUpdateResponse;
  };
  readonly "session.overview.read": {
    readonly params: SessionOverviewReadRequest;
    readonly result: SessionOverviewReadResponse;
  };
}
/** The session directory methods' wire contract: name, procedure type and types. */
export const SESSION_DIRECTORY_METHOD_DESCRIPTORS: SessionDirectoryMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "session.create": /* @__PURE__ */ Object.freeze({
      method: "session.create",
      procedureType: "mutation",
      mutating: true,
    }),
    "session.subscribe": /* @__PURE__ */ Object.freeze({
      method: "session.subscribe",
      procedureType: "subscription",
      mutating: false,
    }),
    "session.event.subscribe": /* @__PURE__ */ Object.freeze({
      method: "session.event.subscribe",
      procedureType: "subscription",
      mutating: false,
    }),
    "session.convert": /* @__PURE__ */ Object.freeze({
      method: "session.convert",
      procedureType: "mutation",
      mutating: true,
    }),
    "session.fork": /* @__PURE__ */ Object.freeze({
      method: "session.fork",
      procedureType: "mutation",
      mutating: true,
    }),
    "session.workingFolder.update": /* @__PURE__ */ Object.freeze({
      method: "session.workingFolder.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "session.overview.read": /* @__PURE__ */ Object.freeze({
      method: "session.overview.read",
      procedureType: "query",
      mutating: false,
    }),
  });
