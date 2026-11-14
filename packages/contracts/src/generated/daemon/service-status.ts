// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The status file the service writes in its run folder: why it cannot start, the stop under way, or why it cannot stop.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { ProcessIdentity } from "../process-identity.js";

/**
 * Each stop step's words after `The background service is still`, keyed by the step's wire
 * name.
 */
export const DAEMON_STOP_STEP_PHRASES = {
  gateway: "closing the connection to the app",
  capabilityRefresh: "finishing a check of what the sidekicks can do",
  toolServers: "disconnecting the MCP servers",
  runQueue: "pausing the queued messages",
  repositoryAttachments: "ending the repositories' background work",
  attentionDecisions: "finishing the notifications under way",
  webAddressSender: "sending the last message to the web address",
  pricing: "finishing the price updates",
  sessionFollows: "finishing the chats' updates",
  chatsRecount: "finishing the chats' updates",
  chatsChanges: "finishing the chats' updates",
  terminals: "closing the terminals",
  signIns: "ending the sign-ins under way",
  scheduler: "stopping the background jobs",
  folderWatch: "stopping the watch on the repositories' folders",
  searchIndex: "closing the search index",
  mcpSettle: "finishing the MCP server changes",
  mcpSignIns: "ending the MCP server sign-ins under way",
  providers: "stopping the sidekicks",
  liveRunsDrain: "ending the turns still running",
  turnCaptures: "saving the file changes of the last turns",
  gitTrees: "cleaning up after git",
  workspaceWorkSettle: "finishing the workspace cleanup",
  dataFolderClose: "closing the saved sessions",
} as const;

/**
 * Why the service cannot start, in `reason`, with the folder a damaged store's copy sits in.
 */
export type DaemonCannotStart =
  | {
      reason: "connectionNameTaken";
    }
  | {
      reason: "turnedOffInLoginItems";
    }
  | {
      reason: "savedSessionsUnrepaired";
      /**
       * The folder the damaged saved sessions are copied aside in.
       */
      asideFolder: string;
    }
  | {
      reason: "savedSessionsFromAnotherVersion";
    }
  | {
      reason: "tokenFileMissing";
    };
/**
 * A step of the service's stop that a `stopping` record names while its wait runs.
 */
export type DaemonStopStep =
  | "gateway"
  | "capabilityRefresh"
  | "toolServers"
  | "runQueue"
  | "repositoryAttachments"
  | "attentionDecisions"
  | "webAddressSender"
  | "pricing"
  | "sessionFollows"
  | "chatsRecount"
  | "chatsChanges"
  | "terminals"
  | "signIns"
  | "scheduler"
  | "folderWatch"
  | "searchIndex"
  | "mcpSettle"
  | "mcpSignIns"
  | "providers"
  | "liveRunsDrain"
  | "turnCaptures"
  | "gitTrees"
  | "workspaceWorkSettle"
  | "dataFolderClose";
/**
 * Why the service's last stop failed, in `reason`.
 */
export type DaemonCannotStop = {
  reason: "stopIntent";
};
/**
 * The status file's content: one of three facts, keyed by its name.
 */
export type ServiceStatusFile =
  | {
      cannotStart: DaemonCannotStart;
    }
  | {
      stopping: DaemonStopping;
    }
  | {
      cannotStop: DaemonCannotStop;
    };

/**
 * The stop under way: the step it waits on, when it began and the service's own process.
 */
export interface DaemonStopping {
  /**
   * The step under way.
   */
  step: DaemonStopStep;
  /**
   * When the stop began, on the wall clock.
   */
  stopStarted: WireInstant;
  /**
   * The service's own process, so a reader knows the record is stale once that process is gone.
   */
  process: ProcessIdentity;
}

export {
  validateDaemonCannotStart,
  validateDaemonCannotStop,
  validateDaemonStopStep,
  validateDaemonStopping,
  validateServiceStatusFile,
} from "../checks/daemon/service-status.js";
