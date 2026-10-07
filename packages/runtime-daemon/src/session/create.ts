// Creating a session: its lead as the request spells it, on the provider's current account, bound
// where it works in the same call. A chat's managed workspace is made before the session exists,
// so a workspace that cannot be made leaves no session behind; a project session binds to its
// project's mount. The session is born `provisioning` with `session.created`, which brings in its
// lead, and reads `active` once bound.

import type { Database, Statement } from "better-sqlite3";

import { AgentIdSchema, type AgentProviderBinding } from "@ai-sidekicks/contracts/agent/definition";
import {
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import { PROVIDER_LABELS, type ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { ExecutionMode, RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type {
  SessionCreateRequest,
  SessionCreateResponse,
  SessionLead,
} from "@ai-sidekicks/contracts/session/directory";
import type {
  SessionCreatedPayload,
  SessionLifecycleChangePayload,
} from "@ai-sidekicks/contracts/session/events";
import { SESSION_GROUP_REFUSED_CODE } from "@ai-sidekicks/contracts/session/groups";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { MachineSettingsFile } from "../daemon/machine/settings/file.js";
import type { WriteStatement } from "../database/statement.js";
import { WriteRefusedError } from "../database/writer.js";
import type { EventLogService } from "../events/log-service.js";
import { DaemonDomainError } from "../ipc/domain-error.js";
import { mintUuidV7 } from "../uuid-v7.js";
import type { ManagedWorkspaceService } from "../workspace/managed/service.js";
import type { WorkspaceService } from "../workspace/service.js";
import { sessionGroupPlacementStatement } from "./groups/store.js";

const SESSION_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// Holds only while the account the lead was resolved to is still the provider's current one.
const CURRENT_ACCOUNT_SQL = `SELECT 1 FROM provider_accounts
  WHERE account_id = @accountId AND provider = @provider AND is_default = 1`;

const INSERT_CONSOLE_STATE_SQL = `INSERT INTO session_console_state
  (session_id, advisor_model, updated_at) VALUES (?, ?, ?)`;

// The account a lead runs on, with the guard that keeps it so inside the session's first write.
interface ResolvedAccount {
  readonly providerAccountId: ProviderAccountId;
  readonly guard: WriteStatement;
}

/** What creating a session reads, appends and binds through. */
export interface SessionCreationDeps {
  /** The read-only connection the accounts and groups are read on. */
  readonly reader: Database;
  /** The append path the session's events go through. */
  readonly events: Pick<EventLogService, "append">;
  /** Binds the session to the mount it works in. */
  readonly workspaces: Pick<WorkspaceService, "bind">;
  /** Makes a chat's managed workspace and its mount, and removes them when the chat is not born. */
  readonly managedWorkspaces: Pick<ManagedWorkspaceService, "create" | "delete">;
  /** The machine's settings file: its advisor default, and where the last lead pick is kept. */
  readonly settingsFile: Pick<MachineSettingsFile, "read" | "update">;
  /** The clock that stamps the session's events. Defaults to the system clock. */
  readonly now?: () => Date;
}

/**
 * Creates sessions as the person asks for them. Refuses a request that names a saved definition,
 * since this daemon holds none, and a lead whose provider has no account to run on.
 */
export class SessionCreation {
  readonly #events: Pick<EventLogService, "append">;
  readonly #workspaces: Pick<WorkspaceService, "bind">;
  readonly #managedWorkspaces: Pick<ManagedWorkspaceService, "create" | "delete">;
  readonly #settingsFile: Pick<MachineSettingsFile, "read" | "update">;
  readonly #now: () => Date;
  readonly #selectCurrentAccount: Statement<[ProviderName], { readonly accountId: string }>;
  readonly #selectAnyAccount: Statement<[ProviderName]>;
  readonly #selectProjectGroup: Statement<[string, string]>;

  constructor(deps: SessionCreationDeps) {
    this.#events = deps.events;
    this.#workspaces = deps.workspaces;
    this.#managedWorkspaces = deps.managedWorkspaces;
    this.#settingsFile = deps.settingsFile;
    this.#now = deps.now ?? (() => new Date());
    this.#selectCurrentAccount = deps.reader.prepare(
      "SELECT account_id AS accountId FROM provider_accounts WHERE provider = ? AND is_default = 1",
    );
    this.#selectAnyAccount = deps.reader.prepare(
      "SELECT 1 FROM provider_accounts WHERE provider = ? LIMIT 1",
    );
    this.#selectProjectGroup = deps.reader.prepare(
      "SELECT 1 FROM session_groups WHERE id = ? AND project_id = ?",
    );
  }

  /**
   * Creates the session and answers once it is bound and active, with the lead's binding as
   * `session.created` records it. The lead runs on the provider, model and effort the request
   * names, never on a value from the settings file, and on the provider's current account; the
   * lead's model and effort are then kept there as the last pick. Throws
   * `agent.definition_not_found` for a request naming a definition,
   * `provideraccount.not_registered` or `provideraccount.no_default` for a lead with no account,
   * and `session.group_refused` for a group outside the session's project, each before anything is
   * written. A chat whose workspace cannot be made, or whose `session.created` is not written,
   * leaves neither a session nor a workspace. A failure in the bind leaves the session
   * `provisioning`.
   */
  async create(request: SessionCreateRequest): Promise<SessionCreateResponse> {
    const lead = leadOf(request);
    if (request.binding.kind === "project" && request.groupId !== undefined) {
      this.#refuseGroupOutsideProject(request.groupId, request.binding.repoMountId);
    }
    const account = this.#resolveAccount(lead);
    const sessionId = mintUuidV7() as SessionId;
    const shape = request.binding.kind;
    const { settings } = await this.#settingsFile.read();

    let mount: { repoMountId: RepoMountId; executionMode: ExecutionMode };
    let binding: AgentProviderBinding;
    if (request.binding.kind === "chat") {
      const workspace = await this.#managedWorkspaces.create({ sessionId });
      mount = { repoMountId: workspace.repoMountId, executionMode: "bound-root" };
      binding = await this.#appendCreatedOrRemoveWorkspace(
        sessionId,
        lead,
        account,
        settings.advisorModel,
      );
    } else {
      mount = request.binding;
      binding = await this.#appendCreated(sessionId, shape, lead, account, settings.advisorModel);
    }
    await this.#workspaces.bind({
      sessionId,
      repoMountId: mount.repoMountId,
      executionMode: mount.executionMode,
    });
    await this.#appendActivated(sessionId, request.groupId);

    await this.#settingsFile.update({
      lastLeadModel: { driverName: lead.driverName, modelId: lead.modelId, effort: lead.effort },
    });
    return { sessionId, shape, state: "active", lead: binding };
  }

  // A chat's workspace exists before its session does, so a session that is not born takes its
  // workspace with it.
  async #appendCreatedOrRemoveWorkspace(
    sessionId: SessionId,
    lead: SessionLead,
    account: ResolvedAccount,
    advisorModel: string | null,
  ): Promise<AgentProviderBinding> {
    try {
      return await this.#appendCreated(sessionId, "chat", lead, account, advisorModel);
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

  // A refused account guard means the current account moved after it was read, so it is resolved
  // again. Answers the binding the lead was born on.
  async #appendCreated(
    sessionId: SessionId,
    shape: SessionCreatedPayload["shape"],
    lead: SessionLead,
    firstAccount: ResolvedAccount,
    advisorModel: string | null,
  ): Promise<AgentProviderBinding> {
    for (let account = firstAccount; ; account = this.#resolveAccount(lead)) {
      const binding: AgentProviderBinding = {
        ...lead,
        providerAccountId: account.providerAccountId,
      };
      const createdAt = this.#now().toISOString();
      const payload: SessionCreatedPayload = {
        sessionId,
        shape,
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
          { transactionalPrelude: [account.guard, ...consoleState] },
        );
        return binding;
      } catch (error) {
        if (error instanceof WriteRefusedError && error.statementIndex === 0) {
          continue;
        }
        throw error;
      }
    }
  }

  async #appendActivated(
    sessionId: SessionId,
    groupId: SessionCreateRequest["groupId"],
  ): Promise<void> {
    const payload: SessionLifecycleChangePayload = {
      sessionId,
      previousState: "provisioning",
      newState: "active",
    };
    try {
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
        {
          transactionalPrelude:
            groupId === undefined ? [] : [sessionGroupPlacementStatement({ sessionId, groupId })],
        },
      );
    } catch (error) {
      if (
        groupId !== undefined &&
        error instanceof WriteRefusedError &&
        error.statementIndex === 0
      ) {
        throw groupRefused(sessionId, groupId);
      }
      throw error;
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
          code: hasAccounts ? "provideraccount.no_default" : "provideraccount.not_registered",
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

  // Refused before anything is written; the placement's own guard in the activation write is what
  // holds the group to the session's project.
  #refuseGroupOutsideProject(groupId: string, repoMountId: RepoMountId): void {
    if (this.#selectProjectGroup.get(groupId, repoMountId) === undefined) {
      throw groupRefused(undefined, groupId);
    }
  }
}

// The lead the request spells out. A saved definition resolves through the definition registry,
// which this daemon does not hold, so a request naming one names a definition it does not have.
function leadOf(request: SessionCreateRequest): SessionLead {
  if (request.leadDefinitionId !== undefined) {
    throw new DaemonDomainError("This machine holds no such saved sidekick.", {
      code: "agent.definition_not_found",
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { definitionId: request.leadDefinitionId },
    });
  }
  if (request.lead === undefined) {
    // The request schema refuses a create that names neither.
    throw new Error("session.create reached the service with no lead");
  }
  return request.lead;
}

function groupRefused(sessionId: SessionId | undefined, groupId: string): DaemonDomainError {
  return new DaemonDomainError("The session cannot sit in that group.", {
    code: SESSION_GROUP_REFUSED_CODE,
    detail: sessionId === undefined ? { groupId } : { sessionId, groupId },
  });
}
