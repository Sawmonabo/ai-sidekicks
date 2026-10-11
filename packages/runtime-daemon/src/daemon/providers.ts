// The daemon's provider side, built once at its start: the run engine and what it writes through,
// the interventions, pauses and provider choices on a run, each provider's driver built from its
// factory, the run queue that starts a person's turns through the memory gate, and the `run.*`,
// `session.restart`, session control and `driver.*` methods they serve. What another part of the
// daemon supplies reaches it through `ProviderPorts`, each registered once by the part that owns
// it; the drivers reach the run queue, which is built over them, through a registration of its own.

import * as path from "node:path";

import { DAEMON_STOP_DRAIN_BOUND_MS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import type { DaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { createMemoryGate } from "../admission/memory-gate.js";
import type { ProcessPeakReader } from "../admission/process-peak/contract.js";
import type { DatabaseConnections } from "../database/connection/lifecycle.js";
import type { DiskFlush } from "../disk-flush/contract.js";
import type { Authorizer } from "../policy/authorizer.js";
import { describeRejection } from "../rejection.js";
import {
  createGitCommand,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  readGitCommonFolder,
  type GitRunner,
} from "../git/process.js";
import { worktreesDirectoryOf } from "../git/worktree/naming.js";
import { StagedChangesWorktrees } from "../git/worktree/staged-changes.js";
import { InterventionService } from "../interventions/service.js";
import { InterventionReader } from "../interventions/store.js";
import {
  registerDriverApplyIntervention,
  registerDriverCompactContext,
  registerDriverInterruptRun,
  registerDriverListCapabilities,
  registerDriverListModels,
  registerDriverListModes,
  registerDriverListProviderCommands,
  type DriverCompactContextDeps,
  type DriverListProviderCommandsDeps,
} from "../ipc/handlers/driver/requests.js";
import {
  resolveDriverForRunOrThrow,
  type DriverDispatchDeps,
  type SessionDriverDeps,
} from "../ipc/handlers/driver/resolution.js";
import { registerRunControlMethods } from "../ipc/handlers/run/control.js";
import { registerRunQueueMethods } from "../ipc/handlers/run/queue.js";
import { registerRunStateSubscribe, RunSafetyHolds } from "../ipc/handlers/run/state.js";
import { registerSessionControlMethods } from "../ipc/handlers/session/control.js";
import {
  registerSessionRestart,
  type SessionRestartDeps,
} from "../ipc/handlers/session/restart.js";
import type { OutboundQueue } from "../ipc/handlers/session/subscribe.js";
import type { StreamingPrimitive } from "../ipc/streaming-primitive.js";
import type { ExecutionPostureService } from "../policy/execution-posture-service.js";
import { DriverCapabilityCache } from "../provider/capability/cache.js";
import { ProviderCommandSearch } from "../provider/command-search.js";
import {
  CAPABILITY_REFRESH_READ_TIMEOUT_MS,
  CapabilityRefresher,
  settleReadWithinDeadline,
  type CapabilityRefreshDriverEntry,
} from "../provider/capability/refresh.js";
import { DriverCapabilitiesWriter } from "../provider/driver/capabilities-writer.js";
import {
  boundFailureDetail,
  type GetCapabilitiesResult,
  type ProviderDriver,
} from "../provider/driver/contract.js";
import { PROVIDER_DRIVER_DESCRIPTORS } from "../provider/driver/descriptor.js";
import { DriverDiagnosticsEmitter } from "../provider/driver/diagnostics.js";
import {
  PROVIDER_DRIVER_FACTORIES,
  type ProviderDriverDependencies,
} from "../provider/driver/factories.js";
import { ProviderRegistry } from "../provider/driver/registry.js";
import type { DaemonTurnBindingResolver } from "../provider/driver/run-control.js";
import { LiveRunBindings } from "../provider/live-run-bindings.js";
import type { PermissionAskPort } from "../provider/port/permission-ask.js";
import type { QuestionPort } from "../provider/port/question.js";
import { PortRegistration } from "../provider/port/registration.js";
import type { SessionRulePort } from "../provider/port/session-rules.js";
import type { ReviewerDenialPort } from "../provider/port/reviewer-denial.js";
import type { CommandOutputPublisher } from "../provider/port/command-output-publisher.js";
import type { ToolServerRoute } from "../provider/port/tool-server-route.js";
import type { RuntimeBindingRebind } from "../provider/runtime-binding-store.js";
import type { ProviderOperatingSystem } from "../provider/operating-system/contract.js";
import { ProviderSessions } from "../queue/provider-session.js";
import { RunQueue } from "../queue/service.js";
import { readSpawnEnvValue, type SpawnEnvPair } from "../provider/spawn-env.js";
import {
  ProviderExecutableUnresolvableError,
  resolveProviderExecutable,
  type ProviderCommandResolver,
} from "../provider/spawned-version.js";
import type { RunEngine } from "../session/run/engine.js";
import { ExecutionEpochs } from "../session/run/epochs.js";
import { RunBindingCursors } from "../session/run/binding-cursors.js";
import { RunInboundDispatch } from "../session/run/inbound.js";
import { RunPauseControl } from "../session/run/pause.js";
import { ProviderChoiceResolver } from "../session/run/provider-choice.js";
import { readSessionMode, sessionModeChangeStatement } from "../session/console-state.js";
import {
  permissionLevelChangeStatement,
  readSessionPermissionLevel,
} from "../session/permission-level.js";
import type {
  SessionDirectoryProviderPort,
  SessionSpawnContextResolver,
} from "../session/directory/provider-port.js";
import { RunStateReader } from "../session/run/read.js";
import { RunAlreadyEndedError, RunNotFoundError } from "../session/run/refusals.js";
import { DaemonApprovals } from "./approvals.js";
import type { RegisteredSessionServices } from "./session-methods.js";

// The socket Codex's hook programs reach the daemon on, beside the daemon's own socket.
const CODEX_HOOK_SOCKET_NAME = "codex-hooks";

// The folder of the role files the daemon writes for Codex helpers, one folder per session.
const CODEX_HELPER_ROLES_FOLDER_NAME = "codex-helper-roles";

// The person's own Codex folder in their home, used where the login shell names no `CODEX_HOME`.
const CODEX_PERSONAL_HOME_FOLDER_NAME = ".codex";

type ClaudeDependencies = ProviderDriverDependencies["claude"];
type CodexDependencies = ProviderDriverDependencies["codex"];
type CodexServiceHome = Awaited<ReturnType<CodexDependencies["homes"]["codexHomeFor"]>>;
type CodexTransportDiagnostic = Parameters<CodexDependencies["reportDiagnostic"]>[0];

// The text a diagnostic's emptied detail is logged as.
const UNDESCRIBED_DIAGNOSTIC_DETAIL = "The diagnostic carried no detail";

/** The session directory's reads and records that the provider side calls. */
interface SessionDirectoryPort {
  /** Where and as whom a session's provider process runs, read at every spawn of either driver. */
  readonly spawnContext: SessionSpawnContextResolver;
  readonly resolveDriverForSession: SessionDriverDeps["resolveDriverForSession"];
  readonly resolveSessionAccess: DriverCompactContextDeps["resolveSessionAccess"];
  readonly resolveRestartTarget: SessionRestartDeps["resolveRestartTarget"];
  /** Records the binding, or the failure, of each resume a driver started on its own. */
  readonly onSessionRelaunched: ClaudeDependencies["onSessionRelaunched"];
  /** The binding the session's lead runs on, whose account a Codex start is weighed against. */
  readonly readLeadBinding: SessionDirectoryProviderPort["readLeadBinding"];
  /** What the session's provider session opens with, at its first admitted run. */
  readonly composeOpening: SessionDirectoryProviderPort["composeOpening"];
  /** The session's newest binding with a conversation to resume. */
  readonly readSessionLeg: SessionDirectoryProviderPort["readSessionLeg"];
  /** The folder the session's runs work in, which a skill pick is read against. */
  readonly requireRunFolder: SessionDirectoryProviderPort["requireRunFolder"];
  /** The folder of the session's live workspace, whose provider files hold its project's rules. */
  readonly readWorkingDirectory: SessionDirectoryProviderPort["readWorkingDirectory"];
}

/** The run queue's reads and calls that the drivers make. */
interface RunQueuePort {
  /** Hands a Codex run the messages the queue holds for it, at a tool boundary of its turn. */
  readonly onToolBoundary: CodexDependencies["onToolBoundary"];
  /** Admits a message Claude Code replayed as taken into the run whose turn took it. */
  readonly onMessageTaken: ClaudeDependencies["onMessageTaken"];
  /** Moves on the messages a Claude Code process that ended kept past their run's end. */
  readonly onProcessGone: ClaudeDependencies["onProcessGone"];
  /** The queued run each Claude Code start dispatches. */
  readonly claudeRunDispatch: Pick<ClaudeDependencies["runDispatchResolver"], "resolveRunDispatch">;
  /** The binding a turn the daemon starts on a session itself opens. */
  readonly daemonTurnBindings: DaemonTurnBindingResolver;
}

/** The agent tree's read of an agent's live bindings in a session. */
interface AgentTreePort {
  readonly resolveAgentBindings: DriverListProviderCommandsDeps["resolveAgentBindings"];
}

/**
 * The ports the drivers, the run engine and the provider methods call, each registered once by
 * the part of the daemon that owns it. Until one is registered, what reaches it waits at the
 * provider, is dropped where it is a live state, or is refused with an error naming the port;
 * each member says which.
 */
export interface ProviderPorts {
  /** The approval pipeline's intake of admitted permission asks; until then an ask waits. */
  readonly permissionAsks: PortRegistration<PermissionAskPort>;
  /** The questions card's intake; until then a question waits. */
  readonly questions: PortRegistration<QuestionPort>;
  /**
   * The approval pipeline's intake of the blocks a provider's own reviewer made; until then a
   * block stays the provider's own, its agent told why and nothing recorded.
   */
  readonly reviewerDenials: PortRegistration<ReviewerDenialPort>;
  /** The approval pipeline's read of each session's own rules; until then a session holds none. */
  readonly sessionRules: PortRegistration<SessionRulePort>;
  /** The running-commands stream's live output; until then a command's output is dropped. */
  readonly commandOutput: PortRegistration<CommandOutputPublisher>;
  /** The daemon's tool-server client's prompts for Codex's `/` list; until then it has none. */
  readonly serverPrompts: CodexDependencies["serverPrompts"];
  /** The session directory's reads and records; until then each call that needs one is refused. */
  readonly sessionDirectory: PortRegistration<SessionDirectoryPort>;
  /** The agent tree's reads; until then the provider command list is refused. */
  readonly agentTree: PortRegistration<AgentTreePort>;
  /**
   * The route the daemon's tool-server front serves each session's tool servers on; until then a
   * session starts with no daemon tool server.
   */
  readonly toolServerRoute: PortRegistration<ToolServerRoute>;
  /**
   * The provider accounts' credential home of each Codex account; until then every Codex session
   * runs on the person's own home, under whichever account it names.
   */
  readonly providerAccounts: PortRegistration<CodexDependencies["homes"]>;
}

/** What the daemon hands its provider side at its start. */
interface DaemonProvidersContext {
  readonly database: DatabaseConnections;
  /**
   * The session services' parts the provider side writes and reads through: the daemon's one
   * event log, every run's provider bindings, and the binding of a message's files.
   */
  readonly sessionServices: Pick<
    RegisteredSessionServices,
    "eventLog" | "runtimeBindings" | "attachments" | "workingFolders" | "projectRules"
  >;
  /** The machine whose providers keep the rules its approvals make. */
  readonly nodeId: NodeId;
  /** The workflow actions' rules, loaded and checked at the daemon's start. */
  readonly authorizer: Authorizer;
  /** The runner for the `git` found along the login shell's `PATH`. */
  readonly git: GitRunner;
  /** The method registry every daemon method is bound onto. */
  readonly methods: MethodRegistry;
  readonly streamingPrimitive: StreamingPrimitive;
  /** The outbound queues of the daemon's connections, which the run streams read. */
  readonly outboundQueue: OutboundQueue;
  /** The registry each driver registers on, which the session services look drivers up in. */
  readonly providerRegistry: ProviderRegistry;
  /** The daemon's one run engine. */
  readonly runEngine: RunEngine;
  /** The posture service each driver reads a session's level and credential policy from. */
  readonly executionPostures: ExecutionPostureService;
  /** The person's home folder, which the curated credential paths are relative to. */
  readonly homeDirectory: string;
  readonly runFolder: DaemonRunFolder;
  /** The daemon's data folder, which holds the files it writes for providers to read. */
  readonly dataFolder: string;
  /** The environment captured at the daemon's start, every provider process's base. */
  readonly providerBaseEnvironment: readonly SpawnEnvPair[];
  /** The operating system the daemon runs on, which each driver reads its system facts from. */
  readonly operatingSystem: ProviderOperatingSystem;
  /** How the files the drivers write for a provider are flushed to disk. */
  readonly diskFlush: DiskFlush;
  /** The memory gate's read of a provider process's peak. */
  readonly processPeakReader: ProcessPeakReader;
  readonly writeServiceLog: (line: string) => void;
}

/**
 * The daemon's provider side. Construction builds every part and binds its methods; `start`
 * registers each driver from one read of its capabilities; `stop` ends the capability refresh and
 * the registration, then every driver's own provider processes.
 */
export class DaemonProviders {
  /** The ports later parts of the daemon register; see {@link ProviderPorts}. */
  readonly ports: ProviderPorts;
  /** The approval pipeline, which registers the ask, block and rule ports as it is built. */
  readonly approvals: DaemonApprovals;

  readonly #providerRegistry: ProviderRegistry;
  readonly #drivers: ReadonlyMap<ProviderName, ProviderDriver>;
  readonly #refresher: CapabilityRefresher;
  readonly #declareCapabilities: (
    driverName: ProviderName,
    result: GetCapabilitiesResult,
  ) => ReturnType<DriverCapabilitiesWriter["declare"]>;
  readonly #writeServiceLog: (line: string) => void;
  readonly #stagedChanges: StagedChangesWorktrees;
  readonly #queue: RunQueue;
  // Ends the run queue's and the binding cursors' follow of every session's committed events.
  readonly #detachRunFollowers: () => void;
  // The registration `start` began, which `stop` waits on; settled until `start` is called.
  #registration: Promise<void> = Promise.resolve();
  #isStopping = false;

  constructor(context: DaemonProvidersContext) {
    const { database, writeServiceLog, providerBaseEnvironment, runEngine } = context;
    this.#writeServiceLog = writeServiceLog;
    this.#providerRegistry = context.providerRegistry;
    const ports: ProviderPorts = {
      permissionAsks: new PortRegistration("permission asks"),
      questions: new PortRegistration("questions"),
      reviewerDenials: new PortRegistration("reviewer denials"),
      sessionRules: new PortRegistration("session rules"),
      commandOutput: new PortRegistration("command output"),
      serverPrompts: new PortRegistration("tool-server prompts"),
      sessionDirectory: new PortRegistration("session directory"),
      agentTree: new PortRegistration("agent tree"),
      toolServerRoute: new PortRegistration("tool-server route"),
      providerAccounts: new PortRegistration("provider accounts' Codex homes"),
    };
    this.ports = ports;
    const { sessionDirectory } = ports;
    // The drivers reach the run queue, which is built over them below, through its registration.
    const runQueue = new PortRegistration<RunQueuePort>("run queue");

    const diagnostics = new DriverDiagnosticsEmitter({
      logSink: {
        record: (record) => {
          writeServiceLog(`driver-diagnostic ${JSON.stringify(record)}`);
        },
      },
    });
    const { eventLog: sessionEvents, runtimeBindings, attachments } = context.sessionServices;
    const executionPosture = context.executionPostures;
    const readNewestCursor = (sessionId: SessionId) => sessionEvents.readNewestCursor(sessionId);
    // The run state streams take Codex's safety holds, which the log never records.
    const holds = new RunSafetyHolds(readNewestCursor);
    const epochs = new ExecutionEpochs({ diagnostics });
    const inbound = new RunInboundDispatch({
      sessionEvents,
      engine: runEngine,
      epochs,
      diagnostics,
      runStatePublisher: holds,
    });
    const runs = new RunStateReader(database.reader);
    // Both drivers point a session's binding at the conversation a fork or rewind moved it onto.
    const rebindRuntimeBinding = async (rebind: RuntimeBindingRebind): Promise<void> => {
      await runtimeBindings.rebind(rebind);
    };
    const stagedChanges = new StagedChangesWorktrees({
      worktreesDirectory: worktreesDirectoryOf(context.homeDirectory),
      git: context.git,
    });
    this.#stagedChanges = stagedChanges;
    const liveRunBindings = new LiveRunBindings({ runs, bindings: runtimeBindings });
    const capabilitiesWriter = new DriverCapabilitiesWriter(database);
    const capabilityCache = new DriverCapabilityCache({
      hydrateDurableCapabilities: (driverName) => capabilitiesWriter.hydrate(driverName),
    });
    // Declares one read durably; a cached report of a build that changed is read again.
    this.#declareCapabilities = async (driverName, result) => {
      const declared = await capabilitiesWriter.declare({ driverName, result });
      if (declared.snapshotChange !== "unchanged" || declared.cliVersionRefreshed) {
        capabilityCache.invalidate(driverName);
      }
      return declared;
    };
    // Each spawn resolves the provider's own command along its own environment's `PATH` again,
    // then where the installers and Node managers put it, the newest build first, so a shell that
    // missed its deadline loses neither provider.
    const commandSearch = new ProviderCommandSearch({
      operatingSystem: context.operatingSystem,
      homeDirectory: context.homeDirectory,
      writeServiceLog,
    });
    const providerCommandOf =
      (driverName: ProviderName): ProviderCommandResolver =>
      async (spawnEnvironment) =>
        await resolveProviderExecutable(
          driverName,
          PROVIDER_DRIVER_DESCRIPTORS[driverName].command,
          spawnEnvironment,
          { commandSearch, operatingSystem: context.operatingSystem },
        );
    const bindingCursors = new RunBindingCursors({ store: runtimeBindings, epochs, runs });
    // The binding a resume the driver started on its own minted opens its cursor before the
    // directory records it, since the resumed provider delivers under it at once.
    const onSessionRelaunched: ClaudeDependencies["onSessionRelaunched"] = (sessionId, result) => {
      const directory = sessionDirectory.requirePort();
      const predecessor =
        result.status === "resumed" ? directory.readSessionLeg(sessionId) : undefined;
      // The directory logs a relaunch with no binding to replace. A cursor that cannot open
      // throws to the driver, which reports its relaunch failed.
      if (predecessor !== undefined && result.status === "resumed") {
        bindingCursors.continueBinding(predecessor, result.bindingId);
      }
      directory.onSessionRelaunched(sessionId, result);
    };
    const askPorts = {
      permissionAsks: ports.permissionAsks,
      questions: ports.questions,
      reviewerDenials: ports.reviewerDenials,
      sessionRules: ports.sessionRules,
    };
    const personalCodexHome: CodexServiceHome = {
      codexHome:
        readSpawnEnvValue(
          providerBaseEnvironment,
          "CODEX_HOME",
          context.operatingSystem.environmentNameMatch,
        ) ?? path.join(context.homeDirectory, CODEX_PERSONAL_HOME_FOLDER_NAME),
      providerAccountId: undefined,
      isManaged: false,
    };

    const drivers = {
      claude: PROVIDER_DRIVER_FACTORIES.claude({
        ...askPorts,
        providerCommand: providerCommandOf("claude"),
        toolServerRoute: ports.toolServerRoute,
        spawnContext: {
          resolveSpawnContext: async (sessionId, providerAccountId) =>
            await sessionDirectory
              .requirePort()
              .spawnContext.resolveSpawnContext(sessionId, providerAccountId),
        },
        runDispatchResolver: {
          resolveRunDispatch: async (params) =>
            await runQueue.requirePort().claudeRunDispatch.resolveRunDispatch(params),
          openDaemonTurnBinding: async (runId, sessionId) =>
            await runQueue.requirePort().daemonTurnBindings.openDaemonTurnBinding(runId, sessionId),
        },
        attachments,
        stagedChanges,
        onSessionRelaunched,
        onMessageTaken: (sessionId, messageId, runId) => {
          runQueue.requirePort().onMessageTaken(sessionId, messageId, runId);
        },
        onProcessGone: (sessionId) => {
          runQueue.requirePort().onProcessGone(sessionId);
        },
        rebindRuntimeBinding,
        providerBaseEnvironment,
        operatingSystem: context.operatingSystem,
        diskFlush: context.diskFlush,
        credentialPolicy: executionPosture,
        runEngine,
        inbound,
        diagnostics,
      }),
      codex: PROVIDER_DRIVER_FACTORIES.codex({
        ...askPorts,
        providerCommand: providerCommandOf("codex"),
        serverPrompts: ports.serverPrompts,
        commandOutput: ports.commandOutput,
        toolServerRoute: ports.toolServerRoute,
        daemonTurnBindings: {
          openDaemonTurnBinding: async (runId, sessionId) =>
            await runQueue.requirePort().daemonTurnBindings.openDaemonTurnBinding(runId, sessionId),
        },
        homes: {
          codexHomeFor: async (providerAccountId) =>
            ports.providerAccounts.port === undefined
              ? personalCodexHome
              : await ports.providerAccounts.port.codexHomeFor(providerAccountId),
        },
        spawnContext: {
          resolveSpawnContext: async (sessionId, providerAccountId) =>
            await sessionDirectory
              .requirePort()
              .spawnContext.resolveSpawnContext(sessionId, providerAccountId),
        },
        onSessionRelaunched,
        providerBaseEnvironment,
        operatingSystem: context.operatingSystem,
        diskFlush: context.diskFlush,
        credentialPolicy: executionPosture,
        runEngine,
        inbound,
        attachments,
        onToolBoundary: (boundary) => {
          runQueue.requirePort().onToolBoundary(boundary);
        },
        hookEndpoint: context.operatingSystem.localSocketEndpoint(
          context.runFolder.folderPath,
          CODEX_HOOK_SOCKET_NAME,
        ),
        helperRolesFolder: path.join(context.dataFolder, CODEX_HELPER_ROLES_FOLDER_NAME),
        readGitFolder: async (projectFolder) =>
          await readGitCommonFolder(
            createGitCommand({ git: context.git, timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS }),
            projectFolder,
          ),
        reportDiagnostic: (diagnostic) => {
          writeServiceLog(`codex-transport ${JSON.stringify(boundDiagnosticDetail(diagnostic))}`);
        },
        diagnostics,
        rebindRuntimeBinding,
        // No provider frame ends a run whose turn the driver lost, so the daemon ends it. A run
        // that ended meanwhile needs nothing; a failed end is a diagnostic the person sees.
        onLostRunFailure: (sessionId, runId, failure) => {
          runEngine
            .applyProviderStateChange({
              runId,
              newState: "failed",
              failureCategory: failure.failureCategory,
              recoveryCondition: failure.recoveryCondition,
              providerFailureDetail: failure.providerFailureDetail,
            })
            .catch((cause: unknown) => {
              if (cause instanceof RunAlreadyEndedError) {
                return;
              }
              diagnostics.emit({
                provider: "codex",
                kind: "delivery_dispatch_failed",
                rawWireType: null,
                dispositionReason: boundFailureDetail(
                  describeRejection(cause),
                  UNDESCRIBED_DIAGNOSTIC_DETAIL,
                ),
                details: { deliveryKind: "run_lifecycle", sessionId, runId },
              });
            });
        },
      }),
    } satisfies Record<ProviderName, ProviderDriver>;
    this.#drivers = new Map<ProviderName, ProviderDriver>([
      ["claude", drivers.claude],
      ["codex", drivers.codex],
    ]);

    this.#refresher = new CapabilityRefresher({
      drivers: [...this.#drivers].map(
        ([driverName, driver]): CapabilityRefreshDriverEntry => ({
          driverName,
          refreshDeclaration: async () =>
            await this.#declareCapabilities(driverName, await driver.getCapabilities()),
        }),
      ),
      diagnostics,
    });

    const providerRegistry = this.#providerRegistry;
    const runDispatch: DriverDispatchDeps = {
      providerRegistry,
      resolveDriverForRun: (runId) => liveRunBindings.resolveDriverForRun(runId),
    };
    const resolveSessionAccess = (sessionId: SessionId): boolean =>
      sessionDirectory.requirePort().resolveSessionAccess(sessionId);
    const sessionDrivers = {
      providerRegistry,
      resolveDriverForSession: (sessionId: SessionId) =>
        sessionDirectory.requirePort().resolveDriverForSession(sessionId),
    };
    this.approvals = new DaemonApprovals({
      database,
      eventLog: sessionEvents,
      nodeId: context.nodeId,
      dataFolder: context.dataFolder,
      authorizer: context.authorizer,
      runEngine,
      runDispatch,
      sessionDrivers,
      workingFolders: context.sessionServices.workingFolders,
      ports: { ...ports, projectRules: context.sessionServices.projectRules },
      methods: context.methods,
      writeServiceLog,
    });
    const providerSessions = new ProviderSessions({
      runtimeBindings,
      bindingCursors,
      resolveDriver: (driverName) => drivers[driverName],
      readContractVersion: (driverName) =>
        capabilityCache.read(driverName).capabilities.contractVersion,
      composeOpening: async (sessionId) =>
        await sessionDirectory.requirePort().composeOpening(sessionId),
      readSessionLeg: (sessionId) => sessionDirectory.requirePort().readSessionLeg(sessionId),
      readSessionMode: (sessionId) => readSessionMode(database.reader, sessionId),
      readPermissionLevel: (sessionId) => readSessionPermissionLevel(database.reader, sessionId),
      recordPermissionLevel: async (sessionId, level) => {
        await database.writer.write([permissionLevelChangeStatement(sessionId, level)]);
      },
    });
    const queue = new RunQueue({
      sessionEvents,
      reader: database.reader,
      writer: database.writer,
      readNewestCursor,
      engine: runEngine,
      providerSessions,
      sessions: sessionDrivers,
      memoryGate: createMemoryGate({ peakReader: context.processPeakReader }),
      startsCodexAccountService: async (sessionId) =>
        await drivers.codex.startsAccountService(
          sessionDirectory.requirePort().readLeadBinding(sessionId)?.providerAccountId ?? undefined,
        ),
      readCodexSkillFiles: async (sessionId) => {
        const port = sessionDirectory.requirePort();
        return await drivers.codex.readSkillFiles(
          sessionId,
          port.readLeadBinding(sessionId)?.providerAccountId ?? undefined,
          port.requireRunFolder(sessionId),
        );
      },
      readProviderProcessId: (sessionId) => {
        const driverName = sessionDrivers.resolveDriverForSession(sessionId);
        return driverName === undefined ? undefined : drivers[driverName].readProcessId(sessionId);
      },
      writeServiceLog,
    });
    this.#queue = queue;
    const interventions = new InterventionService({
      runs,
      interventions: new InterventionReader(database.reader),
      sessionEvents,
      resolveDriver: (runId) => resolveDriverForRunOrThrow(runDispatch, runId).driver,
      retryOnFasterModel: async (request) => {
        const run = runs.getRun(request.targetRunId);
        if (run === undefined) {
          throw new RunNotFoundError(request.targetRunId);
        }
        const { driver } = resolveDriverForRunOrThrow(runDispatch, request.targetRunId);
        return await driver.retryTurnOnFasterModel({
          sessionId: run.sessionId,
          runId: request.targetRunId,
          expectedTurnId: request.expectedTurnId,
          model: request.model,
        });
      },
      runEngine,
      queue,
    });
    // A session whose events could not all be read has its waiting messages read again.
    this.#detachRunFollowers = sessionEvents.followAll(
      (event) => {
        bindingCursors.observe(event);
        queue.lifecycle.observe(event);
      },
      (sessionId) => void queue.lifecycle.reconcile(sessionId),
    );
    runQueue.register({
      onToolBoundary: (boundary) => {
        queue.delivery.onToolBoundary(boundary);
      },
      onMessageTaken: (sessionId, messageId, runId) => {
        queue.delivery.messageTaken(sessionId, messageId, runId);
      },
      onProcessGone: (sessionId) => {
        queue.lifecycle.onProcessGone(sessionId);
      },
      claudeRunDispatch: queue.admission,
      daemonTurnBindings: queue.admission,
    });

    const { methods, streamingPrimitive, outboundQueue } = context;
    registerRunControlMethods(methods, {
      ...runDispatch,
      interventions,
      pauseControl: new RunPauseControl({ runs, engine: runEngine }),
      choices: new ProviderChoiceResolver({ reader: database.reader, runs, engine: runEngine }),
      continuedMessages: {
        read: (runId) => queue.delivery.readWaitingMessages(runId),
        admit: async (sessionId, runId) => await queue.lifecycle.admitContinued(sessionId, runId),
        release: async (sessionId, runId) =>
          await queue.lifecycle.releaseContinued(sessionId, runId),
      },
    });
    registerRunQueueMethods(methods, {
      queue,
      recorder: queue.recorder,
      sessions: sessionDrivers,
      streamingPrimitive,
      outboundQueue,
    });
    registerRunStateSubscribe(methods, {
      streamingPrimitive,
      outboundQueue,
      readNewestCursor,
      followSession: (sessionId, afterCursor, listener) =>
        sessionEvents.follow(sessionId, afterCursor, listener),
      holds,
    });
    registerSessionRestart(methods, {
      providerRegistry,
      resolveRestartTarget: (sessionId) =>
        sessionDirectory.requirePort().resolveRestartTarget(sessionId),
    });
    registerSessionControlMethods(methods, {
      ...sessionDrivers,
      streamingPrimitive,
      recordSessionMode: async (sessionId, mode) => {
        await database.writer.write([
          sessionModeChangeStatement(sessionId, mode, new Date().toISOString()),
        ]);
      },
      providerSessions,
    });
    registerDriverListCapabilities(methods, { providerRegistry, capabilityCache });
    registerDriverListModels(methods, { providerRegistry });
    registerDriverListModes(methods, { providerRegistry });
    registerDriverInterruptRun(methods, runDispatch);
    registerDriverApplyIntervention(methods, runDispatch);
    registerDriverCompactContext(methods, {
      providerRegistry,
      resolveSessionAccess,
      resolveRunBinding: (sessionId, runId) => liveRunBindings.resolveRunBinding(sessionId, runId),
    });
    registerDriverListProviderCommands(methods, {
      providerRegistry,
      resolveSessionAccess,
      resolveAgentBindings: (sessionId, agentId) =>
        ports.agentTree.requirePort().resolveAgentBindings(sessionId, agentId),
    });
  }

  /**
   * Removes the staged-review worktrees a stopped daemon left, then registers every driver side by
   * side, each from one read of its capabilities, bounded by the capability read's deadline and
   * declared durably; resolves once all have settled. A driver whose read fails or does not
   * settle, such as a provider not installed, is left unregistered, so its methods answer
   * `driver.unavailable`, and the service log says why; a read that settles after its deadline or
   * after `stop` registers nothing, and a start after `stop` starts nothing.
   */
  start(): Promise<void> {
    if (!this.#isStopping) {
      this.#registration = this.#register();
    }
    return this.#registration;
  }

  /**
   * Reads every session's waiting messages again, so a queued run a restart left starts on its
   * driver; call it once `start` has settled and the start's recovery pass has settled the runs it
   * found live. After a stop it starts nothing; a failure is logged.
   */
  async recoverRunQueue(): Promise<void> {
    if (this.#isStopping) {
      return;
    }
    try {
      await this.#queue.recover();
    } catch (error) {
      this.#writeServiceLog(
        `The run queue's waiting messages were not read again: ${describeRejection(error)}`,
      );
    }
  }

  async #register(): Promise<void> {
    // Before any driver registers, so no review's new worktree is swept.
    for (const failure of await this.#stagedChanges.sweepLeftWorktrees()) {
      this.#writeServiceLog(
        `A staged-review worktree a previous run left was not removed: ${describeRejection(failure)}`,
      );
    }
    await Promise.all(
      [...this.#drivers].map(async ([driverName, driver]) => {
        const outcome = await settleReadWithinDeadline(async () => {
          const result = await driver.getCapabilities();
          await this.#declareCapabilities(driverName, result);
          return result;
        }, CAPABILITY_REFRESH_READ_TIMEOUT_MS);
        if (outcome.settled === "fulfilled") {
          if (!this.#isStopping) {
            this.#providerRegistry.register(driverName, driver, outcome.value.capabilities);
          }
        } else {
          this.#writeServiceLog(
            `The ${driverName} driver was not registered: ` +
              (outcome.settled === "rejected"
                ? describeRegistrationFailure(outcome.reason)
                : `its capability read did not settle within ` +
                  `${String(CAPABILITY_REFRESH_READ_TIMEOUT_MS)}ms`),
          );
        }
      }),
    );
  }

  /**
   * Ends the run queue's follow of the log, the capability refresh and the registration, so no
   * run's end moves the queue, no read starts and no driver registers after it; waits, within the
   * stop's drain bound, for a registration read still running, so the processes it started are
   * among those ended; then, side by side, ends the approval pipeline's follows and has every
   * driver end the provider processes it started, never the person's own Codex service. Rejects
   * with what failed once every one has stopped.
   */
  async stop(): Promise<void> {
    this.#isStopping = true;
    this.#detachRunFollowers();
    this.#refresher.shutdown();
    await settleReadWithinDeadline(() => this.#registration, DAEMON_STOP_DRAIN_BOUND_MS);
    const outcomes = await Promise.allSettled([
      this.approvals.stop(),
      ...[...this.#drivers.values()].map(async (driver) => {
        await driver.shutdown();
      }),
    ]);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Stopping the approvals or ending the provider processes at the stop failed",
      );
    }
  }
}

// Why a capability read failed, naming the command and its reason where none was found, since that
// error's message is the fixed refusal sentence.
function describeRegistrationFailure(reason: unknown): string {
  return reason instanceof ProviderExecutableUnresolvableError
    ? `${reason.message} (${reason.fields.requestedCommand}: ${reason.fields.reason})`
    : describeRejection(reason);
}

// A Codex diagnostic with its free `detail` text bounded, since it can quote a provider's output.
function boundDiagnosticDetail(diagnostic: CodexTransportDiagnostic): CodexTransportDiagnostic {
  return "detail" in diagnostic
    ? {
        ...diagnostic,
        detail: boundFailureDetail(diagnostic.detail, UNDESCRIBED_DIAGNOSTIC_DETAIL),
      }
    : diagnostic;
}
