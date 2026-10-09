// Builds the daemon's session services on its one database and binds every `session.*` verb they
// answer, plus `transcript.search`. The daemon's one event log is built here with the session
// directory's statements, so each event's `sessions` row change commits in the event's own write,
// and the sessions list follows that log from the start, before any append; the daemon's recovery
// pass and its damaged history append through the same log, which refuses a damaged session's
// writes, and every session read and search stops at a damaged session's last good point. The
// services' background work starts only once the recovery pass has ended.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { DatabaseConnections } from "../database/connection/lifecycle.js";
import { EventLogService } from "../events/log-service.js";
import type { DamagedFromSequenceReader } from "../events/session/read.js";
import { SessionPurge } from "../events/session/purge.js";
import { DEFAULT_GIT_FILESYSTEM } from "../git/filesystem.js";
import {
  createHookNeutralizedGitCommand,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  executionRootsDirectoryOf,
  type GitRunner,
} from "../git/process.js";
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
import { registerSessionSubscribe, type OutboundQueue } from "../ipc/handlers/session/subscribe.js";
import { registerSessionTagMethods } from "../ipc/handlers/session/tags.js";
import { registerTranscriptSearch } from "../ipc/handlers/transcript-methods.js";
import type { StreamingPrimitive } from "../ipc/streaming-primitive.js";
import type { ProviderRegistry } from "../provider/driver/registry.js";
import { RuntimeBindingStore } from "../provider/runtime-binding-store.js";
import { SessionAutoTitle } from "../session/auto-title.js";
import { SessionChanges } from "../session/changes.js";
import { SessionConversion } from "../session/convert.js";
import { SessionCreation } from "../session/create.js";
import { directoryStatementsFor } from "../session/directory/row.js";
import { SessionListFeed } from "../session/directory/list-feed.js";
import { SessionDraftStore } from "../session/draft-store.js";
import { SessionGroupService } from "../session/groups/service.js";
import { SessionLinkService } from "../session/links/service.js";
import { SessionRelatedRanking } from "../session/related/ranking.js";
import { FileSearchService } from "../session/search/files/service.js";
import { SearchIndexMerging } from "../session/search/merging.js";
import type { SearchThread } from "../session/search/thread/handle.js";
import { SessionService } from "../session/service.js";
import { SessionTagService } from "../session/tags/service.js";
import { WorkspaceEventEmitter } from "../workspace/event-emitter.js";
import { ManagedWorkspaceService } from "../workspace/managed/service.js";
import { ManagedWorkspaceWriteWatcher } from "../workspace/managed/write-watcher.js";
import { RepoMountService } from "../workspace/repo/mount-service.js";
import { RepoRootResolver } from "../workspace/repo/root-resolver.js";
import { WorkspaceService } from "../workspace/service.js";
import type { MachineSettingsFile } from "./machine/settings/file.js";

/** What the session services are built from. */
export interface SessionMethodsDeps {
  readonly database: DatabaseConnections;
  /** The person's home folder; a chat's managed workspace lives in the data folder inside it. */
  readonly homeDirectory: string;
  /** This machine's id, which every mount row it attaches carries. */
  readonly nodeId: NodeId;
  /** The runner for the `git` the daemon found along the login shell's `PATH` at start. */
  readonly git: GitRunner;
  /** The machine settings file, which a create reads and writes the last lead model to. */
  readonly settingsFile: MachineSettingsFile;
  /** The provider drivers, whose close ends a closed session's provider leg. */
  readonly providers: ProviderRegistry;
  /** The streaming primitive every streaming handler shares. */
  readonly streamingPrimitive: StreamingPrimitive;
  /** The connections' outbound queues, which a session stream reads before it sends a frame. */
  readonly outboundQueue: OutboundQueue;
  /** The thread searches and the search index's merges run on, with its own read connection. */
  readonly searchThread: SearchThread;
  /** Throws when the session takes no event of `eventType`, its history damaged. */
  readonly refuseSessionWrite: (sessionId: SessionId, eventType: string) => void;
  /** Where a damaged session's reads stop. */
  readonly readDamagedFromSequence: DamagedFromSequenceReader;
  /** Writes one line to the service log. */
  readonly writeServiceLog: (line: string) => void;
}

/** What the daemon goes on to use of the session services it registered. */
export interface RegisteredSessionServices {
  /** The daemon's one event log, every append carrying the session directory's statements. */
  readonly eventLog: EventLogService;
  /** The session reads, a session's events paged after a sequence among them. */
  readonly sessions: SessionService;
  /** The whole-session purge, which deletes a session a person deletes. */
  readonly purge: SessionPurge;
  /**
   * The one watch over every chat's managed workspace; its `whenFailed` says when it stopped
   * reporting writes.
   */
  readonly managedWorkspaceWrites: Pick<ManagedWorkspaceWriteWatcher, "whenFailed">;
  /**
   * Starts the background work, once the recovery pass has ended: the self-naming, the related
   * lists' rename follow, the index's merging, the passes finishing the creates and removing the
   * conversions' copies the daemon stopped part way, and the managed workspaces' write watch. Does
   * nothing once `stop` has been called.
   */
  readonly start: () => Promise<void>;
  /**
   * Ends the sessions list and the background work `start` began, after a start under way. It
   * settles once each of them has finished what it had under way: the titles on their way, the
   * merge step at the writer, the related-list round and the two stopped-work passes.
   */
  readonly stop: () => Promise<void>;
}

/** Builds the session services and registers their verbs on `registry`. */
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
  const git = createHookNeutralizedGitCommand({
    git: deps.git,
    filesystem: DEFAULT_GIT_FILESYSTEM,
    executionRootsDirectory: executionRootsDirectoryOf(deps.homeDirectory),
    timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  });
  const workspaceEvents = new WorkspaceEventEmitter({ sessionEvents: eventLog });
  const workspaces = new WorkspaceService({ database, events: workspaceEvents });
  const repoMounts = new RepoMountService({
    database,
    events: workspaceEvents,
    nodeId: deps.nodeId,
    resolver: new RepoRootResolver({ git: deps.git }),
    // The create service is built from the mounts below, and a detach comes only through a call.
    archiveUnfinishedCreates: () => creation.archiveUnfinishedCreates(),
  });
  const managedWorkspaces = new ManagedWorkspaceService({
    homeDirectory: deps.homeDirectory,
    repoMounts,
    git: deps.git,
  });
  const changes = new SessionChanges({
    reader: database.reader,
    events: eventLog,
    providers: deps.providers,
    runtimeBindings: new RuntimeBindingStore(database),
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
    workspaces,
    writeServiceLog: deps.writeServiceLog,
  });
  const draftStore = new SessionDraftStore(database);
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
    subscribeToSession: (sessionId, afterCursor, listener) =>
      eventLog.follow(sessionId, afterCursor, listener),
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
  registerTranscriptSearch(registry, {
    transcriptSearch: {
      searchTranscript: (request) =>
        deps.searchThread.searchTranscript(
          request,
          deps.readDamagedFromSequence(request.sessionId),
        ),
    },
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
    sessionLock: changes.lock,
    sessionList: listFeed,
    relatedRanking,
  });
  // A stop can come while the recovery pass runs, before any start, or while a start is under way.
  let isStopped = false;
  let watchStarting: Promise<void> | undefined;
  let stopBackgroundWork: (() => Promise<void>) | undefined;
  return {
    eventLog,
    sessions,
    purge,
    managedWorkspaceWrites: writeWatcher,
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
      await watchStarting;
      await stopBackgroundWork?.();
    },
  };
}
