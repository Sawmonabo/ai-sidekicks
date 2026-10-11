// Builds the daemon's session services on its one database and binds every `session.*` verb they
// answer, plus `transcript.read`, `transcript.search` and the session's shells' `pty.*` verbs, then
// the repository services and the artifact store over the same database, sharing the service's one
// scheduler. The daemon's one event log is built here with the session directory's statements, so
// each event's `sessions` row change commits in the event's own write, and the sessions list
// follows that log from the start, before any append; the daemon's recovery pass and its damaged
// history append through the same log, which refuses a damaged session's writes, and every session
// read and search stops at a damaged session's last good point. One transcript projector serves
// both the read windows and the run stamp on each streamed change. The services' background work
// starts only once the recovery pass has ended.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import type { DatabaseConnections } from "../database/connection/lifecycle.js";
import { EventLogService } from "../events/log-service.js";
import type { DamagedFromSequenceReader } from "../events/session/read.js";
import { SessionPurge } from "../events/session/purge.js";
import { findBranchPatternRefusal } from "../git/branch-name-pattern.js";
import {
  createGitCommand,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  type GitRunner,
} from "../git/process.js";
import { worktreesDirectoryOf } from "../git/worktree/naming.js";
import { registerPtyInputOutputMethods } from "../ipc/handlers/pty/input-output.js";
import { registerPtyShellMethods } from "../ipc/handlers/pty/shells.js";
import { registerSessionConvert } from "../ipc/handlers/session/convert.js";
import { registerSessionCreate } from "../ipc/handlers/session/create.js";
import { registerSessionDraftUpdate } from "../ipc/handlers/session/draft-update.js";
import { registerSessionGroupMethods } from "../ipc/handlers/session/groups.js";
import { registerSessionLifecycleMethods } from "../ipc/handlers/session/lifecycle.js";
import { registerSessionLinkMethods } from "../ipc/handlers/session/links.js";
import { registerSessionList } from "../ipc/handlers/session/list.js";
import { registerSessionMarkMethods } from "../ipc/handlers/session/marks.js";
import { registerSessionRead } from "../ipc/handlers/session/read.js";
import { registerSessionRename } from "../ipc/handlers/session/rename.js";
import {
  registerSessionFileSearch,
  registerSessionSearch,
} from "../ipc/handlers/session/search.js";
import { registerSessionSetTerminalFlowControl } from "../ipc/handlers/session/set-terminal-flow-control.js";
import { registerSessionSubscribe, type OutboundQueue } from "../ipc/handlers/session/subscribe.js";
import { registerSessionTagMethods } from "../ipc/handlers/session/tags.js";
import { registerSessionTakeControl } from "../ipc/handlers/session/take-control.js";
import {
  registerTranscriptRead,
  registerTranscriptSearch,
} from "../ipc/handlers/transcript-methods.js";
import type { StreamingPrimitive } from "../ipc/streaming-primitive.js";
import type { ProviderRegistry } from "../provider/driver/registry.js";
import { ProviderConversationPurge } from "../provider/conversation-purge.js";
import type { SpawnEnvNameMatch, SpawnEnvPair } from "../provider/spawn-env.js";
import type { TerminalOperatingSystem } from "../pty/operating-system/contract.js";
import { RuntimeBindingStore } from "../provider/runtime-binding-store.js";
import type { RunSetupGate } from "../session/run/setup-gates.js";
import type { PtyHost } from "../pty/host/contract.js";
import type { PtySessionEvents } from "../pty/host/session-events.js";
import { ShellTable } from "../pty/shell/table.js";
import { SessionAutoTitle } from "../session/auto-title.js";
import { SessionChanges } from "../session/changes.js";
import { SessionConversion } from "../session/convert.js";
import { SessionCreation } from "../session/create.js";
import { directoryStatementsFor } from "../session/directory/row.js";
import { SessionListFeed } from "../session/directory/list-feed.js";
import { SessionDirectoryProviderPort } from "../session/directory/provider-port.js";
import { SessionDraftStore } from "../session/draft-store.js";
import { SessionGroupService } from "../session/groups/service.js";
import { SessionLinkService } from "../session/links/service.js";
import { SessionRelatedRanking } from "../session/related/ranking.js";
import { FileSearchService } from "../session/search/files/service.js";
import { SearchIndexMerging } from "../session/search/merging.js";
import type { SearchThread } from "../session/search/thread/handle.js";
import { sessionLifecycleEvent } from "../session/lifecycle-event.js";
import { SessionService } from "../session/service.js";
import { SessionTagService } from "../session/tags/service.js";
import { prepareWorkingFolderRead } from "../session/working-folder/read.js";
import { TranscriptProjector } from "../transcript/projector.js";
import { TranscriptWindowReader } from "../transcript/window.js";
import { WorkspaceEventEmitter } from "../workspace/event-emitter.js";
import type { StreamedGitRunner } from "../workspace/clone/streamed-git.js";
import type { FolderPlace } from "../workspace/folder/place.js";
import { ManagedWorkspaceService } from "../workspace/managed/service.js";
import { ManagedWorkspaceWriteWatcher } from "../workspace/managed/write-watcher.js";
import { ProjectListFeed } from "../workspace/project/list-feed.js";
import { ProjectRecords } from "../workspace/project/records.js";
import { ProjectService } from "../workspace/project/service.js";
import { RepoMountService } from "../workspace/repo/mount-service.js";
import { RepoRootResolver } from "../workspace/repo/root-resolver.js";
import { WorkspaceService } from "../workspace/service.js";
import { registerArtifactMethods } from "./artifact-methods.js";
import type { MachineSettingsFile } from "./machine/settings/file.js";
import { registerRepoMethods } from "./repo-methods.js";
import { Scheduler } from "./scheduler.js";

/** What the session services are built from. */
export interface SessionMethodsDeps {
  readonly database: DatabaseConnections;
  /** The person's home folder; a chat's managed workspace lives in the data folder inside it. */
  readonly homeDirectory: string;
  /** This machine's id, which every mount row it attaches carries. */
  readonly nodeId: NodeId;
  /** The runner for the `git` the daemon found along the login shell's `PATH` at start. */
  readonly git: GitRunner;
  /** The same `git`, run streamed for a clone or a fetch. */
  readonly streamedGit: StreamedGitRunner;
  /** Where a folder sits on a Windows computer with WSL. */
  readonly folderPlace: FolderPlace;
  /** The machine settings file, which a create reads and writes the last lead model to. */
  readonly settingsFile: MachineSettingsFile;
  /**
   * The provider drivers, whose close ends a closed session's provider leg and whose purge deletes
   * a deleted session's conversations.
   */
  readonly providers: ProviderRegistry;
  /** The streaming primitive every streaming handler shares. */
  readonly streamingPrimitive: StreamingPrimitive;
  /** The connections' outbound queues, which a session stream reads before it sends a frame. */
  readonly outboundQueue: OutboundQueue;
  /** The thread searches and the search index's merges run on, with its own read connection. */
  readonly searchThread: SearchThread;
  /** Settles once the start's check of the database file has ended. */
  readonly whenFileCheckEnds: Promise<unknown>;
  /** Throws when the session takes no event of `eventType`, its history damaged. */
  readonly refuseSessionWrite: (sessionId: SessionId, eventType: string) => void;
  /** Where a damaged session's reads stop. */
  readonly readDamagedFromSequence: DamagedFromSequenceReader;
  /**
   * The account's login shell, which a project's setup commands and every session's shells run
   * in; `null` runs the system's default one.
   */
  readonly commandShell: string | null;
  /** How this system compares environment variable names, which setup commands are built under. */
  readonly environmentNameMatch: SpawnEnvNameMatch;
  /**
   * The login shell's environment captured at the start, which setup commands and every shell are
   * built from.
   */
  readonly providerBaseEnvironment: readonly SpawnEnvPair[];
  /**
   * The daemon's run folder, which only this account may open; a shell's startup files go there.
   */
  readonly runFolderPath: string;
  /** What the terminal takes from the operating system it runs on. */
  readonly terminalOperatingSystem: TerminalOperatingSystem;
  /** Reads the person's login shell, which each shell opens; `null` where the account has none. */
  readonly readLoginShell: () => string | null;
  /** The service's own release version, which each shell's terminal names when a program asks. */
  readonly serviceVersion: string;
  /** Reads the free bytes on the volume holding a folder, which an upload is admitted against. */
  readonly readVolumeFreeBytes: (folderPath: string) => Promise<number>;
  /** Writes one line to the service log. */
  readonly writeServiceLog: (line: string) => void;
  /** The terminal host every session's shells run in. */
  readonly ptyHost: PtyHost;
  /** Hands each of the host's sessions its own output and exit. */
  readonly ptySessionEvents: PtySessionEvents;
  /** This machine's own device id, which a run's hold on a shell names. */
  readonly machineDeviceId: DeviceId;
}

/** What the daemon goes on to use of the session and repository services it registered. */
export interface RegisteredSessionServices {
  /** The daemon's one event log, every append carrying the session directory's statements. */
  readonly eventLog: EventLogService;
  /** The session reads, a session's events paged after a sequence among them. */
  readonly sessions: SessionService;
  /** The whole-session purge, which deletes a session a person deletes. */
  readonly purge: SessionPurge;
  /** The store of every run's provider bindings, which the provider side writes too. */
  readonly runtimeBindings: RuntimeBindingStore;
  /** The session directory's reads and records that the provider side calls. */
  readonly providerPort: SessionDirectoryProviderPort;
  /**
   * The one watch over every chat's managed workspace; its `whenFailed` says when it stopped
   * reporting writes.
   */
  readonly managedWorkspaceWrites: Pick<ManagedWorkspaceWriteWatcher, "whenFailed">;
  /**
   * The gate that makes a run's execution root ready before it starts and releases what the run
   * held once it ends, for the run engine to register.
   */
  readonly setupGate: RunSetupGate;
  /**
   * Starts the background work, once the recovery pass has ended: the self-naming, the related
   * lists' rename follow, the index's merging, the passes finishing the creates and removing the
   * conversions' copies the daemon stopped part way, the managed workspaces' write watch, the
   * repository services' work and the ingest reaper. Does nothing once `stop` has been called.
   */
  readonly start: () => Promise<void>;
  /**
   * Ends the sessions and projects lists, the background work `start` began, after a start under
   * way, the ingest reaper's future passes, the repository services and then the service's
   * scheduler. It settles once each of them has finished what it had under way: the titles on
   * their way, the merge step at the writer, the related-list round, the two stopped-work passes,
   * the scheduler's running job and the repository services' own.
   */
  readonly stop: () => Promise<void>;
  /**
   * Ends a closed connection's bindings on every shell's hold. Called before the connection's
   * subscriptions end, so a hold that ends with the connection is released as a disconnect.
   */
  readonly releaseConnection: (transportId: number) => void;
}

/** Builds the session and repository services and registers their verbs on `registry`. */
export function registerSessionMethods(
  registry: MethodRegistry,
  deps: SessionMethodsDeps,
): RegisteredSessionServices {
  const { database } = deps;
  const eventLog = new EventLogService({
    writer: database.writer,
    reader: database.reader,
    projectionStatements: directoryStatementsFor,
    refuseSessionWrite: deps.refuseSessionWrite,
    readDamagedFromSequence: deps.readDamagedFromSequence,
    writeServiceLog: deps.writeServiceLog,
  });
  const listFeed = new SessionListFeed({
    reader: database.reader,
    eventLog,
    writeServiceLog: deps.writeServiceLog,
  });
  const sessions = new SessionService(database.reader, deps.readDamagedFromSequence);
  const git = createGitCommand({
    git: deps.git,
    timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  });
  const workspaceEvents = new WorkspaceEventEmitter({ sessionEvents: eventLog });
  // One resolver for every service that reads a repository's root and identity.
  const resolver = new RepoRootResolver({ git: deps.git });
  const workspaces = new WorkspaceService({ database, events: workspaceEvents, resolver });
  const repoMounts = new RepoMountService({
    database,
    events: workspaceEvents,
    nodeId: deps.nodeId,
    resolver,
  });
  const managedWorkspaces = new ManagedWorkspaceService({
    homeDirectory: deps.homeDirectory,
    repoMounts,
    git: deps.git,
  });
  const runtimeBindings = new RuntimeBindingStore(database);
  const changes = new SessionChanges({
    reader: database.reader,
    events: eventLog,
    providers: deps.providers,
    runtimeBindings,
  });
  const projectRecords = new ProjectRecords(database.reader, deps.folderPlace);
  const projectListFeed = new ProjectListFeed({
    records: projectRecords,
    eventLog,
    writeServiceLog: deps.writeServiceLog,
  });
  const projects = new ProjectService({
    writer: database.writer,
    records: projectRecords,
    mounts: repoMounts,
    sessions: changes,
    findBranchPatternRefusal: (pattern) => findBranchPatternRefusal(pattern, deps.git),
    folderPlace: deps.folderPlace,
    worktreesDirectory: worktreesDirectoryOf(deps.homeDirectory),
    onProjectsChanged: () => {
      projectListFeed.refresh();
    },
    writeServiceLog: deps.writeServiceLog,
  });
  const creation = new SessionCreation({
    reader: database.reader,
    events: eventLog,
    workspaces,
    managedWorkspaces,
    settingsFile: deps.settingsFile,
    writeServiceLog: deps.writeServiceLog,
  });
  const conversion = new SessionConversion({
    reader: database.reader,
    writer: database.writer,
    events: eventLog,
    lock: changes.lock,
    repoMounts,
    projects,
    workspaces,
    writeServiceLog: deps.writeServiceLog,
    workingTrees: resolver,
  });
  const draftStore = new SessionDraftStore(database);
  const transcriptProjector = new TranscriptProjector(
    database.reader,
    deps.readDamagedFromSequence,
  );
  const relatedRanking = new SessionRelatedRanking({
    reader: database.reader,
    writer: database.writer,
    events: eventLog,
    writeServiceLog: deps.writeServiceLog,
  });

  registerSessionCreate(registry, { createSession: (request) => creation.create(request) });
  registerSessionRead(registry, {
    readSession: async (request) => sessions.readSession(request),
    draftStore,
  });
  registerSessionDraftUpdate(registry, draftStore);
  registerSessionConvert(registry, { conversion });
  registerSessionList(registry, {
    streamingPrimitive: deps.streamingPrimitive,
    outboundQueue: deps.outboundQueue,
    listFeed,
  });
  registerSessionSubscribe(registry, {
    streamingPrimitive: deps.streamingPrimitive,
    outboundQueue: deps.outboundQueue,
    subscribeToSession: (sessionId, afterCursor, listener) => {
      // Made before the follow, whose first catch-up page can arrive inside the call.
      const stampRun = transcriptProjector.createLiveStamper(sessionId);
      return eventLog.follow(sessionId, afterCursor, {
        onChange: (change) => {
          const runStamp = stampRun(change.event);
          listener.onChange(runStamp === undefined ? change : { ...change, runStamp });
        },
        onCaughtUp: () => {
          listener.onCaughtUp();
        },
        onFailure: (error) => {
          listener.onFailure(error);
        },
        isFull: () => listener.isFull(),
        onceDrained: (drainListener) => listener.onceDrained(drainListener),
      });
    },
  });
  registerSessionRename(registry, { changes });
  registerSessionLifecycleMethods(registry, { changes });
  registerSessionMarkMethods(registry, { changes });
  registerSessionGroupMethods(registry, {
    groups: new SessionGroupService({ writer: database.writer, listFeed }),
  });
  registerSessionLinkMethods(registry, {
    links: new SessionLinkService({
      reader: database.reader,
      writer: database.writer,
      relatedRanking,
    }),
    relatedRanking,
    streamingPrimitive: deps.streamingPrimitive,
  });
  registerSessionTagMethods(registry, { tags: new SessionTagService(database) });
  registerSessionSearch(registry, {
    sessionSearch: deps.searchThread,
    readDamagedFromSequence: deps.readDamagedFromSequence,
  });
  registerSessionFileSearch(registry, {
    fileSearch: new FileSearchService({
      reader: database.reader,
      git,
      writeServiceLog: deps.writeServiceLog,
    }),
  });
  registerTranscriptRead(registry, {
    transcriptWindows: new TranscriptWindowReader(
      database.reader,
      transcriptProjector,
      deps.readDamagedFromSequence,
    ),
  });
  registerTranscriptSearch(registry, {
    transcriptSearch: {
      searchTranscript: (request) =>
        deps.searchThread.searchTranscript(
          request,
          deps.readDamagedFromSequence(request.sessionId),
        ),
    },
  });

  const scheduler = new Scheduler({ writeServiceLog: deps.writeServiceLog });
  const repo = registerRepoMethods(registry, {
    database,
    eventLog,
    workspaceEvents,
    workspaces,
    repoMounts,
    projects,
    projectRecords,
    projectListFeed,
    creation,
    resolver,
    git,
    streamedGit: deps.streamedGit,
    settingsFile: deps.settingsFile,
    homeDirectory: deps.homeDirectory,
    folderPlace: deps.folderPlace,
    commandShell: deps.commandShell,
    environmentNameMatch: deps.environmentNameMatch,
    baseEnvironment: deps.providerBaseEnvironment,
    streamingPrimitive: deps.streamingPrimitive,
    outboundQueue: deps.outboundQueue,
    scheduler,
    writeServiceLog: deps.writeServiceLog,
  });
  const shellTable = new ShellTable({
    host: deps.ptyHost,
    followPtySession: (hostSessionId, listeners) =>
      deps.ptySessionEvents.follow(hostSessionId, listeners),
    machineDeviceId: deps.machineDeviceId,
    readWorkingFolder: prepareWorkingFolderRead(database.reader),
    appendControlChange: async (change) => {
      await eventLog.append(
        sessionLifecycleEvent({
          sessionId: change.sessionId,
          type: "pty.control_changed",
          payload: { ...change },
          occurredAt: new Date(),
        }),
      );
    },
    readShellSettings: async (sessionId) => {
      const { settings } = await deps.settingsFile.read();
      return {
        isScreenReaderModeOn: settings.screenReaderMode,
        environmentRows: {
          everyProject: settings.environmentRows,
          project: projectRecords.readEnvironmentRowsOfSession(sessionId),
        },
      };
    },
    readLoginShell: deps.readLoginShell,
    terminalVersion: `sidekicks ${deps.serviceVersion}`,
    baseEnvironment: deps.providerBaseEnvironment,
    environmentNameMatch: deps.environmentNameMatch,
    runFolderPath: deps.runFolderPath,
    operatingSystem: deps.terminalOperatingSystem,
    outboundQueue: deps.outboundQueue,
    writeServiceLog: deps.writeServiceLog,
  });
  registerPtyShellMethods(registry, {
    shellTable,
    streamingPrimitive: deps.streamingPrimitive,
    outboundQueue: deps.outboundQueue,
  });
  registerPtyInputOutputMethods(registry, {
    shellTable,
    streamingPrimitive: deps.streamingPrimitive,
  });
  registerSessionTakeControl(registry, { shellTable });
  registerSessionSetTerminalFlowControl(registry, { shellTable });
  const artifacts = registerArtifactMethods(registry, {
    database,
    homeDirectory: deps.homeDirectory,
    scheduler,
    readVolumeFreeBytes: deps.readVolumeFreeBytes,
  });

  const autoTitle = new SessionAutoTitle({
    reader: database.reader,
    events: eventLog,
    changes,
    writeServiceLog: deps.writeServiceLog,
  });
  const indexMerging = new SearchIndexMerging({
    mergeSegments: () => deps.searchThread.mergeSegments(),
    followIndexCommits: (onCommitted) => deps.searchThread.followIndexCommits(onCommitted),
    writeServiceLog: deps.writeServiceLog,
  });
  const writeWatcher = new ManagedWorkspaceWriteWatcher({
    homeDirectory: deps.homeDirectory,
    writeServiceLog: deps.writeServiceLog,
  });
  const purge = new SessionPurge({
    writer: database.writer,
    nodeId: deps.nodeId,
    eventLog,
    managedWorkspaces,
    providerConversations: new ProviderConversationPurge({
      reader: database.reader,
      runtimeBindings,
      providers: deps.providers,
    }),
    sessionLock: changes.lock,
    sessionList: listFeed,
    relatedRanking,
    whenFileCheckEnds: deps.whenFileCheckEnds,
    shellTable,
  });
  // A stop can come while the recovery pass runs, before any start, or while a start is under way.
  let isStopped = false;
  let watchStarting: Promise<void> | undefined;
  let stopBackgroundWork: (() => Promise<void>) | undefined;
  return {
    eventLog,
    sessions,
    purge,
    runtimeBindings,
    providerPort: new SessionDirectoryProviderPort({
      reader: database.reader,
      runtimeBindings,
      git,
      settingsFile: deps.settingsFile,
      projectRecords,
      writeServiceLog: deps.writeServiceLog,
    }),
    managedWorkspaceWrites: writeWatcher,
    setupGate: repo.setupGate,
    start: () => {
      if (isStopped) {
        return Promise.resolve();
      }
      const stopAutoTitle = autoTitle.start();
      indexMerging.start();
      const stopRelatedRanking = relatedRanking.start();
      // Finishes, in the background, each create the daemon stopped part way, and removes the copy
      // each conversion it stopped part way left.
      const finishingStoppedCreates = creation.finishStoppedCreates();
      const removingStoppedCopies = conversion.removeStoppedCopies();
      repo.start();
      artifacts.start();
      stopBackgroundWork = async () => {
        const mergeStopped = indexMerging.stop();
        const titlesStopped = stopAutoTitle();
        writeWatcher.close();
        await Promise.all([
          mergeStopped,
          titlesStopped,
          stopRelatedRanking(),
          finishingStoppedCreates,
          removingStoppedCopies,
        ]);
      };
      watchStarting = writeWatcher.start();
      return watchStarting;
    },
    stop: async () => {
      isStopped = true;
      listFeed.close();
      projectListFeed.close();
      await watchStarting;
      // The scheduler stops after every user of it: the reaper is canceled here, and the
      // repository services run the stop once their own work schedules nothing more.
      artifacts.stop();
      await Promise.all([stopBackgroundWork?.(), repo.stop(() => scheduler.stop())]);
    },
    releaseConnection: (transportId) => {
      shellTable.releaseConnection(transportId);
    },
  };
}
