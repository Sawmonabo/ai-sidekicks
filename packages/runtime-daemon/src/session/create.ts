// Creating a session: its lead as the request spells it, on the provider's current account, bound
// where it works in the same call. A chat's managed workspace is made before the session exists,
// so a workspace that cannot be made leaves no session behind; a project session binds to its
// project's mount. The session is born `provisioning` with `session.created`, which brings in its
// lead and records the request's idempotency key with where the session works, and reads `active`
// once bound. A create retried with a recorded key answers the session that key made, first
// finishing it when it was left provisioning; the daemon's start finishes any other such session,
// and removes the managed workspace of a chat whose create stopped before it was born.

import type { Database, Statement } from "better-sqlite3";

import { AgentIdSchema, type AgentProviderBinding } from "@ai-sidekicks/contracts/agent/definition";
import {
  PROVIDER_ACCOUNT_NO_DEFAULT_CODE,
  PROVIDER_ACCOUNT_NOT_REGISTERED_CODE,
} from "@ai-sidekicks/contracts/provider/account/methods";
import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import { PROVIDER_LABELS, type ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { ExecutionMode, RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type {
  SessionCreateRequest,
  SessionCreateResponse,
  SessionLead,
} from "@ai-sidekicks/contracts/session/directory";
import {
  SessionCreatedPayloadSchema,
  type SessionCreatedPayload,
  type SessionLifecycleChangePayload,
} from "@ai-sidekicks/contracts/session/events";
import {
  SESSION_GROUP_REFUSED_CODE,
  type SessionGroupId,
} from "@ai-sidekicks/contracts/session/groups";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionShape, SessionState } from "@ai-sidekicks/contracts/session/methods";

import type { MachineSettingsFile } from "../daemon/machine/settings/file.js";
import type { ServiceLogWriter } from "../daemon/service-log.js";
import type { WriteStatement } from "../database/statement.js";
import { WriteRefusedError } from "../database/writer.js";
import type { EventLogService } from "../events/log-service.js";
import { DaemonDomainError } from "../ipc/domain-error.js";
import { KeyedLock } from "../keyed-lock.js";
import { mintUuidV7 } from "../uuid-v7.js";
import type { ManagedWorkspaceService } from "../workspace/managed/service.js";
import { RepoMountManagedError, RepoMountNotFoundError } from "../workspace/repo/errors.js";
import type { WorkspaceService } from "../workspace/service.js";
import { sessionGroupPlacementStatement } from "./groups/store.js";
import { sessionLifecycleEvent } from "./lifecycle-event.js";

const RECORD_CREATE_REQUEST_SQL = `INSERT INTO session_create_requests
  (client_idempotency_key, session_id, repo_mount_id, execution_mode, group_id)
  VALUES (@clientIdempotencyKey, @sessionId, @repoMountId, @executionMode, @groupId)`;

const RECORDED_CREATE_SQL = `SELECT request.session_id AS sessionId,
         request.repo_mount_id AS repoMountId, request.execution_mode AS executionMode,
         request.group_id AS groupId, session.shape, session.state
    FROM session_create_requests AS request
    JOIN sessions AS session ON session.id = request.session_id
   WHERE request.client_idempotency_key = ?`;

const PROVISIONING_CREATES_SQL = `SELECT request.client_idempotency_key AS clientIdempotencyKey,
         request.session_id AS sessionId
    FROM session_create_requests AS request
    JOIN sessions AS session ON session.id = request.session_id
   WHERE session.state = 'provisioning'`;

// The sessions a create left provisioning in a project whose mount has since been detached, so
// they have nowhere left to bind.
const UNFINISHED_CREATES_IN_DETACHED_PROJECTS_SQL = `SELECT
         request.client_idempotency_key AS clientIdempotencyKey, request.session_id AS sessionId
    FROM session_create_requests AS request
    JOIN sessions AS session ON session.id = request.session_id
    JOIN repo_mounts AS mount ON mount.id = request.repo_mount_id
   WHERE session.state = 'provisioning' AND mount.state = 'detached'`;

// Holds only while the session is still being created.
const SESSION_PROVISIONING_SQL = "SELECT 1 FROM sessions WHERE id = ? AND state = 'provisioning'";

// Holds for a session whose create never wrote `session.created`: it has no directory row, no
// recorded create and no event, each of which that write leaves.
function neverBornSql(sessionIdSql: string): string {
  return `NOT EXISTS (SELECT 1 FROM sessions WHERE id = ${sessionIdSql})
     AND NOT EXISTS (SELECT 1 FROM session_create_requests WHERE session_id = ${sessionIdSql})
     AND NOT EXISTS (SELECT 1 FROM session_events WHERE session_id = ${sessionIdSql})`;
}

// The chats whose managed workspace was made but whose create stopped before the chat was born.
const UNBORN_CHATS_SQL = `SELECT managed_session_id AS sessionId FROM repo_mounts AS mount
   WHERE origin = 'managed' AND ${neverBornSql("mount.managed_session_id")}`;

const SESSION_NEVER_BORN_SQL = `SELECT 1 WHERE ${neverBornSql("@sessionId")}`;

// Holds only while the account the lead was resolved to is still the provider's current one.
const CURRENT_ACCOUNT_SQL = `SELECT 1 FROM provider_accounts
  WHERE account_id = @accountId AND provider = @provider AND is_default = 1`;

// Hold only while the project's mount is attached, and is a project the person attached rather
// than a chat's managed workspace.
const MOUNT_ATTACHED_SQL = `SELECT 1 FROM repo_mounts
  WHERE id = @repoMountId AND state = 'attached'`;
const MOUNT_OF_PROJECT_SQL = `SELECT 1 FROM repo_mounts
  WHERE id = @repoMountId AND origin = 'attached'`;

// Holds only while the group belongs to the project the session is being made in.
const GROUP_OF_PROJECT_SQL = `SELECT 1 FROM session_groups
  WHERE id = @groupId AND project_id = @projectId`;

const INSERT_CONSOLE_STATE_SQL = `INSERT INTO session_console_state
  (session_id, advisor_model, updated_at) VALUES (?, ?, ?)`;

// The positions of the guards in the `session.created` write, after the request's record; a
// chat's write carries only the account's.
const ACCOUNT_GUARD_STATEMENT_INDEX = 1;
const MOUNT_ATTACHED_GUARD_STATEMENT_INDEX = 2;
const MOUNT_OF_PROJECT_GUARD_STATEMENT_INDEX = 3;
const GROUP_GUARD_STATEMENT_INDEX = 4;

// The account a lead runs on, with the guard that keeps it so inside the session's first write.
interface ResolvedAccount {
  readonly providerAccountId: ProviderAccountId;
  readonly guard: WriteStatement;
}

// The lead a new session is born with: as the request sent it, the account it was resolved to
// first, and the advisor default a Claude Code session copies.
interface NewLead {
  readonly lead: SessionLead;
  readonly account: ResolvedAccount;
  readonly advisorModel: string | null;
}

// Where a session works and the group it asked for, as its create records them.
interface SessionPlace {
  readonly repoMountId: RepoMountId;
  readonly executionMode: ExecutionMode;
  readonly groupId: SessionGroupId | null;
}

// A create's record joined with the session it made, as that session reads now.
interface RecordedCreate extends SessionPlace {
  readonly sessionId: SessionId;
  readonly shape: SessionShape;
  readonly state: SessionState;
}

/** What creating a session reads, appends and binds through. */
export interface SessionCreationDeps {
  /** The read-only connection the accounts, groups and earlier creates are read on. */
  readonly reader: Database;
  /** The append path the session's events go through. */
  readonly events: Pick<EventLogService, "append">;
  /** Binds the session to the mount it works in. */
  readonly workspaces: Pick<WorkspaceService, "bind">;
  /**
   * Makes a chat's managed workspace and its mount, and removes them when the chat is not born, at
   * once or at the daemon's next start.
   */
  readonly managedWorkspaces: Pick<ManagedWorkspaceService, "create" | "delete">;
  /** The machine's settings file: its advisor default, and where the last lead pick is kept. */
  readonly settingsFile: Pick<MachineSettingsFile, "read" | "update">;
  /** Where a lead pick that could not be kept, or a session left provisioning, is reported. */
  readonly writeServiceLog: ServiceLogWriter;
  /** The clock that stamps the session's events. Defaults to the system clock. */
  readonly now?: () => Date;
}

/**
 * Creates sessions as the person asks for them, one at a time for each idempotency key. Refuses a
 * request that names a saved definition, since this daemon cannot read one, and a lead whose
 * provider has no account to run on.
 */
export class SessionCreation {
  readonly #keyLock = new KeyedLock<string>();
  // The chats whose workspace is made or being made and whose `session.created` has not settled,
  // so the start's removal of unborn chats' workspaces never takes one of theirs.
  readonly #chatsBeingCreated = new Set<SessionId>();
  readonly #events: Pick<EventLogService, "append">;
  readonly #workspaces: Pick<WorkspaceService, "bind">;
  readonly #managedWorkspaces: Pick<ManagedWorkspaceService, "create" | "delete">;
  readonly #settingsFile: Pick<MachineSettingsFile, "read" | "update">;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #now: () => Date;
  readonly #selectCurrentAccount: Statement<[ProviderName], { readonly accountId: string }>;
  readonly #selectAnyAccount: Statement<[ProviderName]>;
  readonly #selectRecordedCreate: Statement<[string], RecordedCreate>;
  readonly #selectProvisioningCreates: Statement<
    [],
    { readonly clientIdempotencyKey: string; readonly sessionId: SessionId }
  >;
  readonly #selectUnfinishedCreatesInDetachedProjects: Statement<
    [],
    { readonly clientIdempotencyKey: string; readonly sessionId: SessionId }
  >;
  readonly #selectCreatedPayload: Statement<[string], { readonly payload: string }>;
  readonly #selectUnbornChats: Statement<[], { readonly sessionId: SessionId }>;
  readonly #selectSessionNeverBorn: Statement<[{ readonly sessionId: string }]>;

  constructor(deps: SessionCreationDeps) {
    this.#events = deps.events;
    this.#workspaces = deps.workspaces;
    this.#managedWorkspaces = deps.managedWorkspaces;
    this.#settingsFile = deps.settingsFile;
    this.#writeServiceLog = deps.writeServiceLog;
    this.#now = deps.now ?? (() => new Date());
    this.#selectCurrentAccount = deps.reader.prepare(
      "SELECT account_id AS accountId FROM provider_accounts WHERE provider = ? AND is_default = 1",
    );
    this.#selectAnyAccount = deps.reader.prepare(
      "SELECT 1 FROM provider_accounts WHERE provider = ? LIMIT 1",
    );
    this.#selectRecordedCreate = deps.reader.prepare(RECORDED_CREATE_SQL);
    this.#selectProvisioningCreates = deps.reader.prepare(PROVISIONING_CREATES_SQL);
    this.#selectUnfinishedCreatesInDetachedProjects = deps.reader.prepare(
      UNFINISHED_CREATES_IN_DETACHED_PROJECTS_SQL,
    );
    this.#selectCreatedPayload = deps.reader.prepare(
      "SELECT payload FROM session_events WHERE session_id = ? AND type = 'session.created'",
    );
    this.#selectUnbornChats = deps.reader.prepare(UNBORN_CHATS_SQL);
    this.#selectSessionNeverBorn = deps.reader.prepare(SESSION_NEVER_BORN_SQL);
  }

  /**
   * Creates the session and answers once it is bound and active, with the lead's binding as
   * `session.created` records it. The lead runs on the provider, model and effort the request
   * names, never on a value from the settings file, and on the provider's current account; the
   * lead's model and effort are then kept there as the last pick, and a pick that cannot be kept is
   * logged without failing the create. A request whose `clientIdempotencyKey` already made a
   * session answers that session as it now reads, after binding and activating it when it was left
   * `provisioning`, and makes nothing else; a request sent while its key's create is still under
   * way waits for it. Throws `provideraccount.not_registered` or `provideraccount.no_default` for
   * a lead with no account, `repo.not_found` for a project whose mount is not attached,
   * `repo.mount_managed` for a chat's managed workspace named as a project, and
   * `session.group_refused` for a group outside the session's project, each before anything is
   * written. A chat whose workspace cannot be made, or
   * whose `session.created` is not written, leaves neither a session nor a workspace. A failure
   * after `session.created` leaves the session `provisioning` until a retry or the daemon's next
   * start finishes it. A group removed before the activation took its sessions out with it, so the
   * session is activated outside any group.
   */
  async create(request: SessionCreateRequest): Promise<SessionCreateResponse> {
    return this.#keyLock.run(request.clientIdempotencyKey, async () => {
      const recorded = this.#selectRecordedCreate.get(request.clientIdempotencyKey);
      if (recorded !== undefined) {
        if (recorded.state !== "provisioning") {
          return this.#answerOf(recorded);
        }
        await this.#finish(recorded);
        const response = this.#answerOf({ ...recorded, state: "active" });
        await this.#keepLastLeadPick(recorded.sessionId, response.lead);
        return response;
      }
      return this.#createNew(request);
    });
  }

  /**
   * Finishes every create the daemon stopped part way. The managed workspace of a chat whose
   * `session.created` was never written is removed with its mount, as the create would have
   * removed it; a session left `provisioning` in a project detached since is archived; and every
   * other session a create left `provisioning` is finished under its key as a retry would. A
   * failure is written to the service log, and what failed is left for the next start, or for a
   * retry of the session's create.
   */
  async finishStoppedCreates(): Promise<void> {
    await this.#removeUnbornChatWorkspaces();
    try {
      await this.archiveUnfinishedCreates();
    } catch (error) {
      this.#writeServiceLog(
        "Archiving the sessions whose project was detached before their create finished failed: " +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const { clientIdempotencyKey, sessionId } of this.#selectProvisioningCreates.all()) {
      try {
        await this.#keyLock.run(clientIdempotencyKey, async () => {
          const recorded = this.#selectRecordedCreate.get(clientIdempotencyKey);
          if (recorded?.state === "provisioning") {
            await this.#finish(recorded);
          }
        });
      } catch (error) {
        this.#writeServiceLog(
          `Finishing session ${sessionId}, which its create left provisioning, failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Archives each session a create left `provisioning` in a project whose mount has since been
   * detached, so no retry or start tries to finish it. Each is archived under its key, after any
   * finish under way; one that finish activated first is left as it is.
   */
  async archiveUnfinishedCreates(): Promise<void> {
    for (const {
      clientIdempotencyKey,
      sessionId,
    } of this.#selectUnfinishedCreatesInDetachedProjects.all()) {
      await this.#keyLock.run(clientIdempotencyKey, async () => {
        const payload: SessionLifecycleChangePayload = {
          sessionId,
          previousState: "provisioning",
          newState: "archived",
        };
        try {
          await this.#events.append(
            sessionLifecycleEvent({
              sessionId,
              type: "session.archived",
              payload: { ...payload },
              occurredAt: this.#now(),
            }),
            {
              transactionalPrelude: [
                { sql: SESSION_PROVISIONING_SQL, bindings: [sessionId], expectedRowCount: 1 },
              ],
            },
          );
        } catch (error) {
          if (!(error instanceof WriteRefusedError)) {
            throw error;
          }
        }
      });
    }
  }

  // A chat counts as being created from before its workspace is made, and as born once its
  // `session.created` write lands, which is checked again just before each removal.
  async #removeUnbornChatWorkspaces(): Promise<void> {
    for (const { sessionId } of this.#selectUnbornChats.all()) {
      if (
        this.#chatsBeingCreated.has(sessionId) ||
        this.#selectSessionNeverBorn.get({ sessionId }) === undefined
      ) {
        continue;
      }
      try {
        await this.#managedWorkspaces.delete({ sessionId });
      } catch (error) {
        this.#writeServiceLog(
          `Removing the managed workspace of chat ${sessionId}, whose create stopped before the ` +
            `chat was born, failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async #createNew(request: SessionCreateRequest): Promise<SessionCreateResponse> {
    const { lead } = request;
    const account = this.#resolveAccount(lead);
    const sessionId = mintUuidV7() as SessionId;
    const { settings } = await this.#settingsFile.read();

    let place: SessionPlace;
    let binding: AgentProviderBinding;
    if (request.binding.kind === "chat") {
      this.#chatsBeingCreated.add(sessionId);
      try {
        const workspace = await this.#managedWorkspaces.create({ sessionId });
        place = { repoMountId: workspace.repoMountId, executionMode: "bound-root", groupId: null };
        binding = await this.#appendCreatedOrRemoveWorkspace(request, sessionId, place, {
          lead,
          account,
          advisorModel: settings.advisorModel,
        });
      } finally {
        this.#chatsBeingCreated.delete(sessionId);
      }
    } else {
      place = {
        repoMountId: request.binding.repoMountId,
        executionMode: request.binding.executionMode,
        groupId: request.groupId ?? null,
      };
      binding = await this.#appendCreated(request, sessionId, place, {
        lead,
        account,
        advisorModel: settings.advisorModel,
      });
    }
    await this.#finish({ sessionId, ...place });
    await this.#keepLastLeadPick(sessionId, lead);
    return { sessionId, shape: request.binding.kind, state: "active", lead: binding };
  }

  // A provisioning session's remaining steps: the bind, which answers the session's workspace on
  // the mount when an earlier bind landed, then the activation.
  async #finish(session: SessionPlace & { readonly sessionId: SessionId }): Promise<void> {
    await this.#workspaces.bind({
      sessionId: session.sessionId,
      repoMountId: session.repoMountId,
      executionMode: session.executionMode,
    });
    await this.#appendActivated(session.sessionId, session.groupId);
  }

  // The session a create made, as it reads now, with the lead it was born on.
  #answerOf(recorded: RecordedCreate): SessionCreateResponse {
    const created = this.#selectCreatedPayload.get(recorded.sessionId);
    if (created === undefined) {
      throw new Error(`Session ${recorded.sessionId} has a directory row but no session.created`);
    }
    const payload = SessionCreatedPayloadSchema.parse(JSON.parse(created.payload));
    return {
      sessionId: recorded.sessionId,
      shape: recorded.shape,
      state: recorded.state,
      lead: payload.mainAgent.binding,
    };
  }

  // A chat's workspace exists before its session does, so a session that is not born takes this
  // workspace with it.
  async #appendCreatedOrRemoveWorkspace(
    request: SessionCreateRequest,
    sessionId: SessionId,
    place: SessionPlace,
    lead: NewLead,
  ): Promise<AgentProviderBinding> {
    try {
      return await this.#appendCreated(request, sessionId, place, lead);
    } catch (creationError) {
      try {
        await this.#managedWorkspaces.delete({ sessionId });
      } catch (removalError) {
        throw new AggregateError(
          [creationError, removalError],
          "The chat was not created, and removing its managed workspace failed too",
          { cause: removalError },
        );
      }
      throw creationError;
    }
  }

  // Appends `session.created` with the request's record, and answers the binding the lead was born
  // on. A project's write holds its mount attached and its group in the project. A refused account
  // guard means the current account moved after it was read, so it is resolved again.
  async #appendCreated(
    request: SessionCreateRequest,
    sessionId: SessionId,
    place: SessionPlace,
    { lead, account: firstAccount, advisorModel }: NewLead,
  ): Promise<AgentProviderBinding> {
    const projectGuards: WriteStatement[] =
      request.binding.kind === "project" ? projectGuardsOf(place) : [];
    for (let account = firstAccount; ; account = this.#resolveAccount(lead)) {
      const binding: AgentProviderBinding = {
        ...lead,
        providerAccountId: account.providerAccountId,
      };
      const createdOn = this.#now();
      const createdAt = createdOn.toISOString();
      const payload: SessionCreatedPayload = {
        sessionId,
        shape: request.binding.kind,
        mainAgent: {
          agentId: AgentIdSchema.parse(mintUuidV7()),
          name: PROVIDER_LABELS[lead.driverName],
          binding,
          ancestry: [],
          createdAt,
        },
      };
      // A Claude Code session keeps its own advisor from here on, copied from today's default.
      const consoleState: WriteStatement[] =
        lead.driverName === "claude"
          ? [{ sql: INSERT_CONSOLE_STATE_SQL, bindings: [sessionId, advisorModel, createdAt] }]
          : [];
      try {
        await this.#events.append(
          sessionLifecycleEvent({
            sessionId,
            type: "session.created",
            payload: { ...payload },
            occurredAt: createdOn,
          }),
          {
            transactionalPrelude: [
              {
                sql: RECORD_CREATE_REQUEST_SQL,
                bindings: {
                  clientIdempotencyKey: request.clientIdempotencyKey,
                  sessionId,
                  repoMountId: place.repoMountId,
                  executionMode: place.executionMode,
                  groupId: place.groupId,
                },
              },
              account.guard,
              ...projectGuards,
              ...consoleState,
            ],
          },
        );
        return binding;
      } catch (error) {
        if (!(error instanceof WriteRefusedError)) {
          throw error;
        }
        if (error.statementIndex === ACCOUNT_GUARD_STATEMENT_INDEX) {
          continue;
        }
        if (error.statementIndex === MOUNT_ATTACHED_GUARD_STATEMENT_INDEX) {
          throw new RepoMountNotFoundError(place.repoMountId);
        }
        if (error.statementIndex === MOUNT_OF_PROJECT_GUARD_STATEMENT_INDEX) {
          throw new RepoMountManagedError(place.repoMountId);
        }
        if (error.statementIndex === GROUP_GUARD_STATEMENT_INDEX) {
          throw groupRefused(place.groupId);
        }
        throw error;
      }
    }
  }

  // The group was held to the session's project in the `session.created` write. An ungroup since
  // then moved every session out of it, so a placement that matches no group leaves this one out
  // too, in the same write that activates it.
  async #appendActivated(sessionId: SessionId, groupId: SessionGroupId | null): Promise<void> {
    const payload: SessionLifecycleChangePayload = {
      sessionId,
      previousState: "provisioning",
      newState: "active",
    };
    const placement: WriteStatement[] = [];
    if (groupId !== null) {
      const { expectedRowCount: _anyRowCount, ...placeUnlessUngrouped } =
        sessionGroupPlacementStatement({ sessionId, groupId });
      placement.push(placeUnlessUngrouped);
    }
    await this.#events.append(
      sessionLifecycleEvent({
        sessionId,
        type: "session.activated",
        payload: { ...payload },
        occurredAt: this.#now(),
      }),
      { transactionalPrelude: placement },
    );
  }

  // The last pick is a remembered preference; the session it was made for is already active, so a
  // failure to keep it is logged rather than failing the create.
  async #keepLastLeadPick(sessionId: SessionId, lead: SessionLead): Promise<void> {
    try {
      await this.#settingsFile.update({
        lastLeadModel: { driverName: lead.driverName, modelId: lead.modelId, effort: lead.effort },
      });
    } catch (error) {
      this.#writeServiceLog(
        `Keeping the lead model session ${sessionId} was created on as the last pick failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #resolveAccount(lead: SessionLead): ResolvedAccount {
    const current = this.#selectCurrentAccount.get(lead.driverName);
    if (current === undefined) {
      const hasAccounts = this.#selectAnyAccount.get(lead.driverName) !== undefined;
      throw new DaemonDomainError(
        hasAccounts
          ? "The provider has accounts but none is current."
          : "The provider has no account registered.",
        {
          code: hasAccounts
            ? PROVIDER_ACCOUNT_NO_DEFAULT_CODE
            : PROVIDER_ACCOUNT_NOT_REGISTERED_CODE,
          detail: { provider: lead.driverName },
        },
      );
    }
    return {
      providerAccountId: current.accountId as ProviderAccountId,
      guard: {
        sql: CURRENT_ACCOUNT_SQL,
        bindings: { accountId: current.accountId, provider: lead.driverName },
        expectedRowCount: 1,
      },
    };
  }
}

// The guards a project's `session.created` write holds, in their statement positions: its mount
// attached, the mount a project's, and the group, when one was asked for, the project's.
function projectGuardsOf(place: SessionPlace): WriteStatement[] {
  const bindings = { repoMountId: place.repoMountId };
  const guards: WriteStatement[] = [
    { sql: MOUNT_ATTACHED_SQL, bindings, expectedRowCount: 1 },
    { sql: MOUNT_OF_PROJECT_SQL, bindings, expectedRowCount: 1 },
  ];
  if (place.groupId !== null) {
    guards.push({
      sql: GROUP_OF_PROJECT_SQL,
      bindings: { groupId: place.groupId, projectId: place.repoMountId },
      expectedRowCount: 1,
    });
  }
  return guards;
}

function groupRefused(groupId: SessionGroupId | null): DaemonDomainError {
  return new DaemonDomainError("The session cannot sit in that group.", {
    code: SESSION_GROUP_REFUSED_CODE,
    detail: { groupId },
  });
}
