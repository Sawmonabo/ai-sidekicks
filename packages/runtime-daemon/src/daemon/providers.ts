// The daemon's provider side, built once at its start: the run engine and what it writes through,
// the interventions, pauses and provider choices on a run, each provider's driver built from its
// factory, and the `run.*`, `session.restart`, session control and `driver.*` methods they serve.
// What a part of the daemon still to be built supplies reaches it through `ProviderPorts`, each
// registered once by the part that owns it.

import * as path from "node:path";

import { DAEMON_STOP_DRAIN_BOUND_MS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import type { DaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { DatabaseConnections } from "../database/connection/lifecycle.js";
import { describeRejection } from "../rejection.js";
import type { EventLogService } from "../events/log-service.js";
import type { GitRunner } from "../git/process.js";
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
import {
  registerDriverSubscribeEvents,
  type DriverSubscribeEventsDeps,
} from "../ipc/handlers/driver/subscribe.js";
import {
  registerRunControlMethods,
  type RunControlHandlerDeps,
} from "../ipc/handlers/run/control.js";
import { registerSessionControlMethods } from "../ipc/handlers/session/control.js";
import {
  registerSessionRestart,
  type SessionRestartDeps,
} from "../ipc/handlers/session/restart.js";
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
import type { ReviewerDenialPort } from "../provider/port/reviewer-denial.js";
import type { CommandOutputPublisher } from "../provider/port/command-output-publisher.js";
import type { RunStatePublisher } from "../provider/port/run-state-publisher.js";
import type { ToolServerRoute } from "../provider/port/tool-server-route.js";
import type {
  RuntimeBindingRebind,
  RuntimeBindingStore,
} from "../provider/runtime-binding-store.js";
import type { ProviderOperatingSystem } from "../provider/operating-system/contract.js";
import { readSpawnEnvValue, type SpawnEnvPair } from "../provider/spawn-env.js";
import {
  ProviderExecutableUnresolvableError,
  resolveProviderExecutable,
  type ProviderCommandResolver,
} from "../provider/spawned-version.js";
import type { RunEngine } from "../session/run/engine.js";
import { ExecutionEpochs } from "../session/run/epochs.js";
import { RunInboundDispatch } from "../session/run/inbound.js";
import { RunPauseControl } from "../session/run/pause.js";
import { ProviderChoiceResolver } from "../session/run/provider-choice.js";
import { sessionModeChangeStatement } from "../session/console-state.js";
import type { SessionSpawnContextResolver } from "../session/directory/provider-port.js";
import { RunStateReader } from "../session/run/read.js";
import { RunAlreadyEndedError, RunNotFoundError } from "../session/run/refusals.js";

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
}

/** The run queue's reads that the provider side calls. */
interface RunQueuePort {
  readonly readWaitingMessages: RunControlHandlerDeps["readWaitingMessages"];
  readonly subscribeToDriverEvents: DriverSubscribeEventsDeps["subscribeToDriverEvents"];
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
  /** The run queue's live run state stream; until then a live state is dropped. */
  readonly runStatePublisher: PortRegistration<RunStatePublisher>;
  /** The running-commands stream's live output; until then a command's output is dropped. */
  readonly commandOutput: PortRegistration<CommandOutputPublisher>;
  /** The daemon's tool-server client's prompts for Codex's `/` list; until then it has none. */
  readonly serverPrompts: CodexDependencies["serverPrompts"];
  /** The session directory's reads and records; until then each call that needs one is refused. */
  readonly sessionDirectory: PortRegistration<SessionDirectoryPort>;
  /** The run queue's reads; until then each call that needs one is refused. */
  readonly runQueue: PortRegistration<RunQueuePort>;
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
  /** The store of every run's provider bindings, which the session services read too. */
  readonly runtimeBindings: RuntimeBindingStore;
  /** The runner for the `git` found along the login shell's `PATH`. */
  readonly git: GitRunner;
  /** The method registry every daemon method is bound onto. */
  readonly methods: MethodRegistry;
  readonly streamingPrimitive: StreamingPrimitive;
  /** The registry each driver registers on, which the session services look drivers up in. */
  readonly providerRegistry: ProviderRegistry;
  /** The daemon's one event log, which every provider event is appended through. */
  readonly eventLog: EventLogService;
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

  readonly #providerRegistry: ProviderRegistry;
  readonly #drivers: ReadonlyMap<ProviderName, ProviderDriver>;
  readonly #refresher: CapabilityRefresher;
  readonly #declareCapabilities: (
    driverName: ProviderName,
    result: GetCapabilitiesResult,
  ) => ReturnType<DriverCapabilitiesWriter["declare"]>;
  readonly #writeServiceLog: (line: string) => void;
  readonly #stagedChanges: StagedChangesWorktrees;
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
      runStatePublisher: new PortRegistration("run state publisher"),
      commandOutput: new PortRegistration("command output"),
      serverPrompts: new PortRegistration("tool-server prompts"),
      sessionDirectory: new PortRegistration("session directory"),
      runQueue: new PortRegistration("run queue"),
      agentTree: new PortRegistration("agent tree"),
      toolServerRoute: new PortRegistration("tool-server route"),
      providerAccounts: new PortRegistration("provider accounts' Codex homes"),
    };
    this.ports = ports;
    const { sessionDirectory, runQueue } = ports;

    const diagnostics = new DriverDiagnosticsEmitter({
      logSink: {
        record: (record) => {
          writeServiceLog(`driver-diagnostic ${JSON.stringify(record)}`);
        },
      },
    });
    const sessionEvents = context.eventLog;
    const executionPosture = context.executionPostures;
    const inbound = new RunInboundDispatch({
      sessionEvents,
      engine: runEngine,
      epochs: new ExecutionEpochs({ diagnostics }),
      diagnostics,
      runStatePublisher: ports.runStatePublisher,
    });
    const runs = new RunStateReader(database.reader);
    const { runtimeBindings } = context;
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
    const onSessionRelaunched: ClaudeDependencies["onSessionRelaunched"] = (sessionId, result) => {
      sessionDirectory.requirePort().onSessionRelaunched(sessionId, result);
    };
    const askPorts = {
      permissionAsks: ports.permissionAsks,
      questions: ports.questions,
      reviewerDenials: ports.reviewerDenials,
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

    this.#drivers = new Map<ProviderName, ProviderDriver>([
      [
        "claude",
        PROVIDER_DRIVER_FACTORIES.claude({
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
              await runQueue
                .requirePort()
                .daemonTurnBindings.openDaemonTurnBinding(runId, sessionId),
          },
          stagedChanges,
          onSessionRelaunched,
          rebindRuntimeBinding,
          providerBaseEnvironment,
          operatingSystem: context.operatingSystem,
          credentialPolicy: executionPosture,
          runEngine,
          inbound,
          diagnostics,
        }),
      ],
      [
        "codex",
        PROVIDER_DRIVER_FACTORIES.codex({
          ...askPorts,
          providerCommand: providerCommandOf("codex"),
          serverPrompts: ports.serverPrompts,
          commandOutput: ports.commandOutput,
          toolServerRoute: ports.toolServerRoute,
          daemonTurnBindings: {
            openDaemonTurnBinding: async (runId, sessionId) =>
              await runQueue
                .requirePort()
                .daemonTurnBindings.openDaemonTurnBinding(runId, sessionId),
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
          credentialPolicy: executionPosture,
          runEngine,
          inbound,
          hookEndpoint: context.operatingSystem.localSocketEndpoint(
            context.runFolder.folderPath,
            CODEX_HOOK_SOCKET_NAME,
          ),
          helperRolesFolder: path.join(context.dataFolder, CODEX_HELPER_ROLES_FOLDER_NAME),
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
          readCapabilities: () => capabilityCache.read("codex").capabilities,
        }),
      ],
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
    });
    const resolveSessionAccess = (sessionId: SessionId): boolean =>
      sessionDirectory.requirePort().resolveSessionAccess(sessionId);

    const { methods, streamingPrimitive } = context;
    registerRunControlMethods(methods, {
      ...runDispatch,
      interventions,
      pauseControl: new RunPauseControl({ runs, engine: runEngine }),
      choices: new ProviderChoiceResolver({ reader: database.reader, runs, engine: runEngine }),
      readWaitingMessages: (runId) => runQueue.requirePort().readWaitingMessages(runId),
    });
    registerSessionRestart(methods, {
      providerRegistry,
      resolveRestartTarget: (sessionId) =>
        sessionDirectory.requirePort().resolveRestartTarget(sessionId),
    });
    registerSessionControlMethods(methods, {
      providerRegistry,
      resolveDriverForSession: (sessionId) =>
        sessionDirectory.requirePort().resolveDriverForSession(sessionId),
      streamingPrimitive,
      recordSessionMode: async (sessionId, mode) => {
        await database.writer.write([
          sessionModeChangeStatement(sessionId, mode, new Date().toISOString()),
        ]);
      },
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
    registerDriverSubscribeEvents(methods, {
      streamingPrimitive,
      subscribeToDriverEvents: (runId, onEvent) =>
        runQueue.requirePort().subscribeToDriverEvents(runId, onEvent),
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
   * Ends the capability refresh and the registration, so no read starts and no driver registers
   * after it; waits, within the stop's drain bound, for a registration read still running, so the
   * processes it started are among those ended; then has every driver end the provider processes
   * it started, side by side, never the person's own Codex service. Rejects with what failed once
   * every driver has stopped.
   */
  async stop(): Promise<void> {
    this.#isStopping = true;
    this.#refresher.shutdown();
    await settleReadWithinDeadline(() => this.#registration, DAEMON_STOP_DRAIN_BOUND_MS);
    const outcomes = await Promise.allSettled(
      [...this.#drivers.values()].map(async (driver) => {
        await driver.shutdown();
      }),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Ending the provider processes at the stop failed");
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
