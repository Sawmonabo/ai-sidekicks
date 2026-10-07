// Creating a session: its lead as the request spells it, on the provider's current account, bound
// where it works in the same call. A chat's managed workspace is made before the session exists,
// so a workspace that cannot be made leaves no session behind; a project session binds to its
// project's mount. The session is born `provisioning` with `session.created`, which brings in its
// lead and records the request's idempotency key, and reads `active` once bound. A create retried
// with a key already recorded answers the session that key made and makes nothing.

import type { Database, Statement } from "better-sqlite3";

import {
  AGENT_DEFINITION_UNREADABLE_CODE,
  AgentIdSchema,
  type AgentProviderBinding,
} from "@ai-sidekicks/contracts/agent/definition";
import {
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";
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
import { SESSION_GROUP_REFUSED_CODE } from "@ai-sidekicks/contracts/session/groups";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionShape, SessionState } from "@ai-sidekicks/contracts/session/methods";

import type { MachineSettingsFile } from "../daemon/machine/settings/file.js";
import type { ServiceLogWriter } from "../daemon/service-log.js";
import type { WriteStatement } from "../database/statement.js";
import { WriteRefusedError } from "../database/writer.js";
import type { EventLogService } from "../events/log-service.js";
import { DaemonDomainError } from "../ipc/domain-error.js";
import { mintUuidV7 } from "../uuid-v7.js";
import type { ManagedWorkspaceService } from "../workspace/managed/service.js";
import type { WorkspaceService } from "../workspace/service.js";
import { sessionGroupPlacementStatement } from "./groups/store.js";

const SESSION_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// Records the request's key against the session it makes; matches no row when the key already
// made one, which refuses the write.
const RECORD_CREATE_REQUEST_SQL = `INSERT INTO session_create_requests
  (client_idempotency_key, session_id) VALUES (@clientIdempotencyKey, @sessionId)
  ON CONFLICT (client_idempotency_key) DO NOTHING`;

// Holds only while the account the lead was resolved to is still the provider's current one.
const CURRENT_ACCOUNT_SQL = `SELECT 1 FROM provider_accounts
  WHERE account_id = @accountId AND provider = @provider AND is_default = 1`;

// Holds only while the group belongs to the project the session is being made in.
const GROUP_OF_PROJECT_SQL = `SELECT 1 FROM session_groups
  WHERE id = @groupId AND project_id = @projectId`;

const INSERT_CONSOLE_STATE_SQL = `INSERT INTO session_console_state
  (session_id, advisor_model, updated_at) VALUES (?, ?, ?)`;

// The positions of the guards in the `session.created` write.
const CREATE_REQUEST_STATEMENT_INDEX = 0;
const ACCOUNT_GUARD_STATEMENT_INDEX = 1;
const GROUP_GUARD_STATEMENT_INDEX = 2;

// The account a lead runs on, with the guard that keeps it so inside the session's first write.
interface ResolvedAccount {
  readonly providerAccountId: ProviderAccountId;
  readonly guard: WriteStatement;
}

// What the `session.created` write came to: the session born on its binding, or an earlier create
// with the same key that made the session first.
type CreatedOutcome =
  | { readonly kind: "created"; readonly binding: AgentProviderBinding }
  | { readonly kind: "earlier"; readonly response: SessionCreateResponse };

/** What creating a session reads, appends and binds through. */
export interface SessionCreationDeps {
  /** The read-only connection the accounts, groups and earlier creates are read on. */
  readonly reader: Database;
  /** The append path the session's events go through. */
  readonly events: Pick<EventLogService, "append">;
  /** Binds the session to the mount it works in. */
  readonly workspaces: Pick<WorkspaceService, "bind">;
  /** Makes a chat's managed workspace and its mount, and removes them when the chat is not born. */
  readonly managedWorkspaces: Pick<ManagedWorkspaceService, "create" | "delete">;
  /** The machine's settings file: its advisor default, and where the last lead pick is kept. */
  readonly settingsFile: Pick<MachineSettingsFile, "read" | "update">;
  /** Where a last lead pick that could not be kept is reported. */
  readonly writeServiceLog: ServiceLogWriter;
  /** The clock that stamps the session's events. Defaults to the system clock. */
  readonly now?: () => Date;
}

/**
 * Creates sessions as the person asks for them. Refuses a request that names a saved definition,
 * since this daemon cannot read one, and a lead whose provider has no account to run on.
 */
export class SessionCreation {
  readonly #events: Pick<EventLogService, "append">;
  readonly #workspaces: Pick<WorkspaceService, "bind">;
  readonly #managedWorkspaces: Pick<ManagedWorkspaceService, "create" | "delete">;
  readonly #settingsFile: Pick<MachineSettingsFile, "read" | "update">;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #now: () => Date;
  readonly #selectCurrentAccount: Statement<[ProviderName], { readonly accountId: string }>;
  readonly #selectAnyAccount: Statement<[ProviderName]>;
  readonly #selectEarlierSession: Statement<
    [string],
    { readonly sessionId: SessionId; readonly shape: SessionShape; readonly state: SessionState }
  >;
  readonly #selectCreatedPayload: Statement<[string], { readonly payload: string }>;

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
    this.#selectEarlierSession = deps.reader.prepare(
      `SELECT request.session_id AS sessionId, session.shape, session.state
         FROM session_create_requests AS request
         JOIN sessions AS session ON session.id = request.session_id
        WHERE request.client_idempotency_key = ?`,
    );
    this.#selectCreatedPayload = deps.reader.prepare(
      "SELECT payload FROM session_events WHERE session_id = ? AND type = 'session.created'",
    );
  }

  /**
   * Creates the session and answers once it is bound and active, with the lead's binding as
   * `session.created` records it. The lead runs on the provider, model and effort the request
   * names, never on a value from the settings file, and on the provider's current account; the
   * lead's model and effort are then kept there as the last pick, and a pick that cannot be kept is
   * logged without failing the create. A request whose `clientIdempotencyKey` already made a
   * session answers that session as it now reads, and makes nothing. Throws
   * `agent.definition_unreadable` for a request naming a definition,
   * `provideraccount.not_registered` or `provideraccount.no_default` for a lead with no account,
   * and `session.group_refused` for a group outside the session's project, each before anything is
   * written. A chat whose workspace cannot be made, or whose `session.created` is not written,
   * leaves neither a session nor a workspace. A failure in the bind leaves the session
   * `provisioning`. A group removed between the session's creation and its activation took its
   * sessions out with it, so the session is activated outside any group.
   */
  async create(request: SessionCreateRequest): Promise<SessionCreateResponse> {
    const earlier = this.#readEarlierCreate(request.clientIdempotencyKey);
    if (earlier !== undefined) {
      return earlier;
    }
    const lead = leadOf(request);
    const account = this.#resolveAccount(lead);
    const sessionId = mintUuidV7() as SessionId;
    const { settings } = await this.#settingsFile.read();

    let mount: { repoMountId: RepoMountId; executionMode: ExecutionMode };
    let outcome: CreatedOutcome;
    if (request.binding.kind === "chat") {
      const workspace = await this.#managedWorkspaces.create({ sessionId });
      mount = { repoMountId: workspace.repoMountId, executionMode: "bound-root" };
      outcome = await this.#appendCreatedOrRemoveWorkspace(
        request,
        sessionId,
        lead,
        account,
        settings.advisorModel,
      );
    } else {
      mount = request.binding;
      outcome = await this.#appendCreated(request, sessionId, lead, account, settings.advisorModel);
    }
    if (outcome.kind === "earlier") {
      return outcome.response;
    }
    await this.#workspaces.bind({
      sessionId,
      repoMountId: mount.repoMountId,
      executionMode: mount.executionMode,
    });
    await this.#appendActivated(sessionId, request.groupId);
    await this.#keepLastLeadPick(sessionId, lead);
    return { sessionId, shape: request.binding.kind, state: "active", lead: outcome.binding };
  }

  // The session an earlier create with this key made, as it reads now, with the lead it was born
  // on; `undefined` when the key made none.
  #readEarlierCreate(clientIdempotencyKey: string): SessionCreateResponse | undefined {
    const session = this.#selectEarlierSession.get(clientIdempotencyKey);
    if (session === undefined) {
      return undefined;
    }
    const created = this.#selectCreatedPayload.get(session.sessionId);
    if (created === undefined) {
      throw new Error(`Session ${session.sessionId} has a directory row but no session.created`);
    }
    const payload = SessionCreatedPayloadSchema.parse(JSON.parse(created.payload));
    return {
      sessionId: session.sessionId,
      shape: session.shape,
      state: session.state,
      lead: payload.mainAgent.binding,
    };
  }

  // A chat's workspace exists before its session does, so a session that is not born, or one an
  // earlier create with the same key made first, takes this workspace with it.
  async #appendCreatedOrRemoveWorkspace(
    request: SessionCreateRequest,
    sessionId: SessionId,
    lead: SessionLead,
    account: ResolvedAccount,
    advisorModel: string | null,
  ): Promise<CreatedOutcome> {
    let outcome: CreatedOutcome;
    try {
      outcome = await this.#appendCreated(request, sessionId, lead, account, advisorModel);
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
    if (outcome.kind === "earlier") {
      await this.#managedWorkspaces.delete({ sessionId });
    }
    return outcome;
  }

  // A refused account guard means the current account moved after it was read, so it is resolved
  // again; a refused key means an earlier create with it made its session first.
  async #appendCreated(
    request: SessionCreateRequest,
    sessionId: SessionId,
    lead: SessionLead,
    firstAccount: ResolvedAccount,
    advisorModel: string | null,
  ): Promise<CreatedOutcome> {
    const groupGuard: WriteStatement[] =
      request.binding.kind === "project" && request.groupId !== undefined
        ? [
            {
              sql: GROUP_OF_PROJECT_SQL,
              bindings: { groupId: request.groupId, projectId: request.binding.repoMountId },
              expectedRowCount: 1,
            },
          ]
        : [];
    for (let account = firstAccount; ; account = this.#resolveAccount(lead)) {
      const binding: AgentProviderBinding = {
        ...lead,
        providerAccountId: account.providerAccountId,
      };
      const createdAt = this.#now().toISOString();
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
          {
            id: mintUuidV7(),
            sessionId,
            occurredAt: createdAt,
            category: "session_lifecycle",
            type: "session.created",
            actor: null,
            payload: { ...payload },
            version: SESSION_EVENT_VERSION,
          },
          {
            transactionalPrelude: [
              {
                sql: RECORD_CREATE_REQUEST_SQL,
                bindings: { clientIdempotencyKey: request.clientIdempotencyKey, sessionId },
                expectedRowCount: 1,
              },
              account.guard,
              ...groupGuard,
              ...consoleState,
            ],
          },
        );
        return { kind: "created", binding };
      } catch (error) {
        if (!(error instanceof WriteRefusedError)) {
          throw error;
        }
        if (error.statementIndex === CREATE_REQUEST_STATEMENT_INDEX) {
          return { kind: "earlier", response: this.#readCommittedEarlierCreate(request) };
        }
        if (error.statementIndex === ACCOUNT_GUARD_STATEMENT_INDEX) {
          continue;
        }
        if (error.statementIndex === GROUP_GUARD_STATEMENT_INDEX) {
          throw groupRefused(request.groupId);
        }
        throw error;
      }
    }
  }

  // The key was refused because an earlier create recorded it, so its session is there to read.
  #readCommittedEarlierCreate(request: SessionCreateRequest): SessionCreateResponse {
    const earlier = this.#readEarlierCreate(request.clientIdempotencyKey);
    if (earlier === undefined) {
      throw new Error(
        `session.create key ${request.clientIdempotencyKey} is recorded for no session`,
      );
    }
    return earlier;
  }

  // The group was held to the session's project in the `session.created` write. An ungroup since
  // then moved every session out of it, so a placement that matches no group leaves this one out
  // too, in the same write that activates it.
  async #appendActivated(
    sessionId: SessionId,
    groupId: SessionCreateRequest["groupId"],
  ): Promise<void> {
    const payload: SessionLifecycleChangePayload = {
      sessionId,
      previousState: "provisioning",
      newState: "active",
    };
    const placement: WriteStatement[] = [];
    if (groupId !== undefined) {
      const { expectedRowCount: _anyRowCount, ...placeUnlessUngrouped } =
        sessionGroupPlacementStatement({ sessionId, groupId });
      placement.push(placeUnlessUngrouped);
    }
    await this.#events.append(
      {
        id: mintUuidV7(),
        sessionId,
        occurredAt: this.#now().toISOString(),
        category: "session_lifecycle",
        type: "session.activated",
        actor: null,
        payload: { ...payload },
        version: SESSION_EVENT_VERSION,
      },
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

// The lead the request spells out. A saved definition resolves through the definition registry,
// which this daemon cannot read yet; a request with no lead names one, since the schema refuses a
// request naming neither.
function leadOf(request: SessionCreateRequest): SessionLead {
  if (request.leadDefinitionId === undefined && request.lead !== undefined) {
    return request.lead;
  }
  throw new DaemonDomainError("Saved sidekicks cannot be read on this machine.", {
    code: AGENT_DEFINITION_UNREADABLE_CODE,
  });
}

function groupRefused(groupId: SessionCreateRequest["groupId"]): DaemonDomainError {
  return new DaemonDomainError("The session cannot sit in that group.", {
    code: SESSION_GROUP_REFUSED_CODE,
    detail: { groupId },
  });
}
