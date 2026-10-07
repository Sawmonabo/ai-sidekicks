// Builds the daemon's session services on its one database and binds every `session.*` verb they
// answer, plus `transcript.search`. The event log is built here with the session directory's
// statements, so each event's `sessions` row change commits in the event's own write, and the
// sessions list follows that log from the start, before any append.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";

import type { DatabaseConnections } from "../database/connections.js";
import { EventLogService } from "../events/log-service.js";
import { DEFAULT_GIT_FILESYSTEM } from "../git/filesystem.js";
import {
  createHookNeutralizedGitCommand,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  executionRootsDirectoryOf,
  runGitWithExecFile,
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
import { SearchIndexIdleMerge } from "../session/search/idle-merge.js";
import { SessionSearchService } from "../session/search/service.js";
import { TranscriptSearchService } from "../session/search/transcript.js";
import { SessionService } from "../session/service.js";
import { SessionTagService } from "../session/tags/service.js";
import { WorkspaceEventEmitter } from "../workspace/event-emitter.js";
import { ManagedWorkspaceService } from "../workspace/managed/service.js";
import { RepoMountService } from "../workspace/repo/mount-service.js";
import { WorkspaceService } from "../workspace/service.js";
import type { MachineSettingsFile } from "./machine/settings/file.js";

/** What the session services are built from. */
export interface SessionMethodsDeps {
  readonly database: DatabaseConnections;
  /** The person's home folder; a chat's managed workspace lives in the data folder inside it. */
  readonly homeDirectory: string;
  /** This machine's id, which every mount row it attaches carries. */
  readonly nodeId: NodeId;
  /** The machine settings file, which a create reads and writes the last lead model to. */
  readonly settingsFile: MachineSettingsFile;
  /** The provider drivers, whose close ends a closed session's provider leg. */
  readonly providers: ProviderRegistry;
  /** The streaming primitive every streaming handler shares. */
  readonly streamingPrimitive: StreamingPrimitive;
  /** The connections' outbound queues, which a session stream reads before it sends a frame. */
  readonly outboundQueue: OutboundQueue;
  /** Writes one line to the service log. */
  readonly writeServiceLog: (line: string) => void;
}

/**
 * Builds the session services and registers their verbs on `registry`. Returns the stop that ends
 * the background work they started: the sessions list, the self-naming, the related lists' rename
 * follow and the index merge. It settles once the related-list round under way has finished, and
 * never rejects.
 */
export function registerSessionMethods(
  registry: MethodRegistry,
  deps: SessionMethodsDeps,
): () => Promise<void> {
  const { database } = deps;
  const eventLog = new EventLogService({
    writer: database.writer,
    reader: database.reader,
    projectionStatements: directoryStatementsFor,
  });
  const listFeed = new SessionListFeed({ reader: database.reader, eventLog });
  const sessions = new SessionService(database.reader);
  const git = createHookNeutralizedGitCommand({
    git: runGitWithExecFile,
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
  });
  const managedWorkspaces = new ManagedWorkspaceService({
    homeDirectory: deps.homeDirectory,
    repoMounts,
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
  registerSessionConvert(registry, {
    conversion: new SessionConversion({
      reader: database.reader,
      events: eventLog,
      lock: changes.lock,
      repoMounts,
      workspaces,
    }),
  });
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
  registerSessionSearch(registry, { sessionSearch: new SessionSearchService(database.reader) });
  registerSessionFileSearch(registry, {
    fileSearch: new FileSearchService({ reader: database.reader, git }),
  });
  registerTranscriptSearch(registry, {
    transcriptSearch: new TranscriptSearchService(database.reader),
  });

  const stopAutoTitle = new SessionAutoTitle({
    reader: database.reader,
    events: eventLog,
    changes,
    writeServiceLog: deps.writeServiceLog,
  }).start();
  const indexMerge = new SearchIndexIdleMerge({
    writer: database.writer,
    followAll: (onCommitted) => eventLog.followAll(onCommitted),
    writeServiceLog: deps.writeServiceLog,
  });
  indexMerge.start();
  const stopRelatedRanking = relatedRanking.start();
  return async () => {
    indexMerge.stop();
    stopAutoTitle();
    listFeed.close();
    await stopRelatedRanking();
  };
}
