// What the session directory answers the provider side: whether a session exists, the provider
// its lead runs on, where and as whom each of its provider processes runs, the resume a restart
// opens, and the binding each resume a driver started on its own minted.
//
// The lead is read from the session's log: `session.created` names it, a provider switch moves it,
// and a session-long model switch the provider made moves the model it runs on. A session's leg is
// its newest binding with a conversation to resume.

import type { Database, Statement } from "better-sqlite3";

import type { AgentProviderBinding } from "@ai-sidekicks/contracts/agent/definition";
import type { AgentProviderBindingChangedPayload } from "@ai-sidekicks/contracts/agent/provider-binding";
import type { UsageModelReroutedPayload } from "@ai-sidekicks/contracts/event/declared-variants";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { SessionCreatedPayload } from "@ai-sidekicks/contracts/session/events";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { describeRejection } from "../../rejection.js";
import type { MachineSettingsFile } from "../../daemon/machine/settings/file.js";
import { readGitCommonFolder, type GitCommand } from "../../git/process.js";
import type { DriverResumeResult, ResumeSessionParams } from "../../provider/driver/contract.js";
import type { ClaudeAccountFolders, SessionEnvironmentRows } from "../../provider/spawn-env.js";
import {
  composeResumeSessionParams,
  type RuntimeBinding,
  type RuntimeBindingStore,
} from "../../provider/runtime-binding-store.js";
import type { ProjectRecords } from "../../workspace/project/records.js";
import { readSessionAdvisorModel, readSessionMode } from "../console-state.js";
import { SESSION_RUN_IDS_SQL } from "../run/ids.js";
import { SESSION_EXISTS_SQL } from "./lookups.js";

/** Where and as whom a session's provider process runs, as either driver reads it at a spawn. */
interface SessionSpawnContext {
  /** The session's working folder, its workspace's root, absolute. */
  readonly workingDirectory: string;
  /** The repository's git folder, the common one for a linked worktree, absolute. */
  readonly gitCommonFolder: string;
  readonly environmentRows: SessionEnvironmentRows | undefined;
  /** The account home the app manages, or `undefined` for the person's own Claude Code home. */
  readonly accountFolders: ClaudeAccountFolders | undefined;
  /** The agent's memory folder and its link, absolute; empty where the agent keeps none. */
  readonly memoryFolders: readonly string[];
  /** The session's own advisor, or `null` when it is off. */
  readonly advisorModel: string | null;
  /** The session's own output style, or `null` where it chose none. */
  readonly outputStyle: string | null;
  /** The instructions a Codex conversation runs under, sent on every start, resume and fork. */
  readonly baseInstructions: string | undefined;
}

/** Resolves, at every spawn of either driver, where and as whom a session's process runs. */
export interface SessionSpawnContextResolver {
  resolveSpawnContext(
    sessionId: SessionId,
    providerAccountId: string | undefined,
  ): Promise<SessionSpawnContext>;
}

/** The provider a session ran on, and its leg rebuilt as the params of a resume. */
interface SessionRestartTarget {
  readonly driverName: ProviderName;
  readonly params: ResumeSessionParams;
}

// The session's lead as its log last left it, and the model it runs on now.
interface SessionLead {
  readonly agentId: string;
  readonly binding: AgentProviderBinding;
  readonly runningModel: string;
}

// The events that name or move the lead, oldest first. A damaged row's payload may not be JSON.
const LEAD_EVENTS_SQL = `SELECT type, payload FROM session_events
  WHERE session_id = ? AND json_valid(payload)
    AND type IN ('session.created', 'agent.provider_binding_changed', 'usage.model_rerouted')
  ORDER BY sequence`;

const OUTPUT_STYLE_SQL = `SELECT json_extract(payload, '$.outputStyle') AS outputStyle
  FROM session_events
  WHERE session_id = ? AND type = 'session.output_style_changed' AND json_valid(payload)
  ORDER BY sequence DESC LIMIT 1`;

// The folder of the session's newest live workspace, once its root is ready.
const WORKING_DIRECTORY_SQL = `SELECT fs_root AS workingDirectory FROM workspaces
  WHERE session_id = ? AND state <> 'archived' AND fs_root IS NOT NULL
  ORDER BY created_at DESC, id DESC LIMIT 1`;

/** What the session directory's provider port reads and records through. */
interface SessionDirectoryProviderPortDeps {
  readonly reader: Database;
  readonly runtimeBindings: Pick<RuntimeBindingStore, "findByRuns" | "recordRelaunch">;
  /** The git the repository's git folder is read with. */
  readonly git: GitCommand;
  /** The machine's settings, whose `Every project` environment rows every session starts with. */
  readonly settingsFile: Pick<MachineSettingsFile, "read">;
  readonly projectRecords: Pick<ProjectRecords, "readEnvironmentRowsOfSession">;
  readonly writeServiceLog: (line: string) => void;
}

/** The session directory's reads and records that the provider side calls. */
export class SessionDirectoryProviderPort {
  readonly #reader: Database;
  readonly #runtimeBindings: SessionDirectoryProviderPortDeps["runtimeBindings"];
  readonly #git: GitCommand;
  readonly #settingsFile: Pick<MachineSettingsFile, "read">;
  readonly #projectRecords: Pick<ProjectRecords, "readEnvironmentRowsOfSession">;
  readonly #writeServiceLog: (line: string) => void;
  readonly #selectSession: Statement<{ sessionId: string }, unknown>;
  readonly #selectLeadEvents: Statement<[string], { type: string; payload: string }>;
  readonly #selectOutputStyle: Statement<[string], { outputStyle: string }>;
  readonly #selectWorkingDirectory: Statement<[string], { workingDirectory: string }>;
  readonly #selectRunIds: Statement<{ sessionId: string }, { runId: string }>;

  /** Every spawn's context, the same for both drivers. */
  readonly spawnContext: SessionSpawnContextResolver = {
    resolveSpawnContext: async (sessionId) => await this.#resolveSpawnContext(sessionId),
  };

  constructor(deps: SessionDirectoryProviderPortDeps) {
    this.#reader = deps.reader;
    this.#runtimeBindings = deps.runtimeBindings;
    this.#git = deps.git;
    this.#settingsFile = deps.settingsFile;
    this.#projectRecords = deps.projectRecords;
    this.#writeServiceLog = deps.writeServiceLog;
    this.#selectSession = deps.reader.prepare(SESSION_EXISTS_SQL);
    this.#selectLeadEvents = deps.reader.prepare(LEAD_EVENTS_SQL);
    this.#selectOutputStyle = deps.reader.prepare(OUTPUT_STYLE_SQL);
    this.#selectWorkingDirectory = deps.reader.prepare(WORKING_DIRECTORY_SQL);
    this.#selectRunIds = deps.reader.prepare(SESSION_RUN_IDS_SQL);
  }

  /** Whether this daemon holds the session. */
  resolveSessionAccess(sessionId: SessionId): boolean {
    return this.#selectSession.get({ sessionId }) !== undefined;
  }

  /** The provider the session's lead runs on, or `undefined` for a session this daemon lacks. */
  resolveDriverForSession(sessionId: SessionId): ProviderName | undefined {
    return this.#readLead(sessionId)?.binding.driverName;
  }

  /**
   * The resume that brings the session's leg back on the model its lead runs on now, in the mode
   * it was last moved to, or `undefined` for a session with no lead or no conversation to resume.
   */
  resolveRestartTarget(sessionId: SessionId): SessionRestartTarget | undefined {
    const lead = this.#readLead(sessionId);
    const binding = this.#readLeg(sessionId);
    if (lead === undefined || binding === undefined) {
      return undefined;
    }
    return {
      driverName: binding.driverName,
      params: composeResumeSessionParams(
        sessionId,
        binding,
        lead.runningModel,
        lead.binding.largerWindow,
        readSessionMode(this.#reader, sessionId),
        {},
      ),
    };
  }

  /**
   * Records the binding a resume the driver started on its own minted, so a restart resumes the
   * conversation it opened; a failed resume, or a binding that could not be recorded, goes to the
   * service log.
   */
  onSessionRelaunched(sessionId: SessionId, result: DriverResumeResult): void {
    if (result.status === "failed") {
      this.#writeServiceLog(
        `The provider could not resume session ${sessionId} on its own ` +
          `(${result.recoveryCondition}): ${result.providerFailureDetail}`,
      );
      return;
    }
    this.#recordRelaunch(sessionId, result).catch((error: unknown) => {
      this.#writeServiceLog(
        `The binding of session ${sessionId}'s relaunch was not recorded: ${describeRejection(error)}`,
      );
    });
  }

  async #recordRelaunch(
    sessionId: SessionId,
    result: Extract<DriverResumeResult, { status: "resumed" }>,
  ): Promise<void> {
    const predecessor = this.#readLeg(sessionId);
    if (predecessor?.resumeHandle == null) {
      throw new Error("the session has no binding the relaunch replaced");
    }
    // A provider that continued the conversation in a new one left the old one behind.
    const leftConversations =
      predecessor.resumeHandle === result.resumeHandle
        ? []
        : [
            {
              sessionId,
              providerAccountId: predecessor.spawnConfig.providerAccountId,
              conversationId: predecessor.resumeHandle,
            },
          ];
    await this.#runtimeBindings.recordRelaunch({
      predecessorId: predecessor.id,
      bindingId: result.bindingId,
      resumeHandle: result.resumeHandle,
      leftConversations,
    });
  }

  async #resolveSpawnContext(sessionId: SessionId): Promise<SessionSpawnContext> {
    const workingDirectory = this.#selectWorkingDirectory.get(sessionId)?.workingDirectory;
    if (workingDirectory === undefined) {
      throw new Error(`Session ${sessionId} has no workspace ready to run in`);
    }
    return {
      workingDirectory,
      gitCommonFolder: await readGitCommonFolder(this.#git, workingDirectory),
      environmentRows: {
        everyProject: (await this.#settingsFile.read()).settings.environmentRows,
        project: this.#projectRecords.readEnvironmentRowsOfSession(sessionId),
      },
      accountFolders: undefined,
      memoryFolders: [],
      advisorModel: readSessionAdvisorModel(this.#reader, sessionId),
      outputStyle: this.#selectOutputStyle.get(sessionId)?.outputStyle ?? null,
      baseInstructions: undefined,
    };
  }

  // The session's newest binding with a conversation to resume.
  #readLeg(sessionId: SessionId): RuntimeBinding | undefined {
    const runIds = this.#selectRunIds.all({ sessionId }).map((row) => row.runId);
    let newest: RuntimeBinding | undefined;
    for (const binding of this.#runtimeBindings.findByRuns(runIds)) {
      if (
        binding.resumeHandle !== null &&
        binding.resumeHandle.length > 0 &&
        (newest === undefined ||
          binding.createdAt > newest.createdAt ||
          (binding.createdAt === newest.createdAt && binding.id > newest.id))
      ) {
        newest = binding;
      }
    }
    return newest;
  }

  #readLead(sessionId: SessionId): SessionLead | undefined {
    let lead: SessionLead | undefined;
    for (const row of this.#selectLeadEvents.all(sessionId)) {
      if (row.type === "session.created") {
        const { mainAgent } = JSON.parse(row.payload) as SessionCreatedPayload;
        lead = {
          agentId: mainAgent.agentId,
          binding: mainAgent.binding,
          runningModel: mainAgent.binding.modelId,
        };
      } else if (lead !== undefined && row.type === "agent.provider_binding_changed") {
        const change = JSON.parse(row.payload) as AgentProviderBindingChangedPayload;
        if (change.agentId === lead.agentId) {
          lead = {
            agentId: lead.agentId,
            binding: { ...change.to, providerAccountId: change.landedProviderAccountId },
            runningModel: change.to.modelId,
          };
        }
      } else if (lead !== undefined) {
        const reroute = JSON.parse(row.payload) as UsageModelReroutedPayload;
        if (
          reroute.scope === "session" &&
          (reroute.agentId === undefined || reroute.agentId === lead.agentId)
        ) {
          lead = { ...lead, runningModel: reroute.toModel };
        }
      }
    }
    return lead;
  }
}
