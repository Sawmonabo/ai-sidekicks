// The service's projects, read off `project.subscribe`: the whole list when the stream opens and
// again on each change. Every delivery is checked here with the contract's generated check. A list
// holding a project that does not match is handed on without it and counts it, each refused
// project's fault going to the window's diagnostic capture; a delivery that is no list at all, or a re-open the
// daemon refuses, is handed on as the list being lost. A stream that ends is opened again and
// restates the list.

import {
  validateProjectList,
  validateProjectListEntry,
  type ProjectListEntry,
} from "@ai-sidekicks/contracts/project";

import { PROJECT_LIST_STREAM } from "#shared/daemon/streams.js";
import { checkFaultPaths } from "#shared/daemon/fault-path.js";
import {
  recordRefusedMemberPaths,
  type RefusedMemberIssues,
} from "#renderer/lib/diagnostic-capture/refused-member-record.js";
import type { ProjectListFeed, ProjectListFrame } from "#renderer/store/projects/list.js";
import type { PlatformBridge } from "../platform/bridge.js";
import { openReopeningSubscription } from "../transport/reopening-subscription.js";

/**
 * The window's project feed over `bridge`, the same function for every caller with that bridge,
 * so every view reading the list shares one stream.
 */
export function projectListFeedFor(bridge: PlatformBridge): ProjectListFeed {
  return projectListFeeds.feedFor(bridge);
}

/** One feed per bridge, made on first ask. */
class ProjectListFeedsByBridge {
  readonly #feedByBridge = new WeakMap<PlatformBridge, ProjectListFeed>();

  public feedFor(bridge: PlatformBridge): ProjectListFeed {
    const known = this.#feedByBridge.get(bridge);
    if (known !== undefined) {
      return known;
    }
    const feed = projectListFeedOver(bridge);
    this.#feedByBridge.set(bridge, feed);
    return feed;
  }
}

/** The feeds this window's bridges have handed out. */
const projectListFeeds = new ProjectListFeedsByBridge();

function projectListFeedOver(bridge: PlatformBridge): ProjectListFeed {
  return (onFrame) =>
    openReopeningSubscription({
      signal: bridge.transportReconnect,
      subject: PROJECT_LIST_STREAM,
      firstOpenFailure: "refuseAndRetry",
      open: (deliver, onEnded) =>
        bridge.daemon.subscribe(PROJECT_LIST_STREAM, {}, deliver, onEnded),
      onFrame: (payload) => {
        onFrame(readProjectListFrame(payload));
      },
      onReopenRefusal: (refusal) => {
        if (refusal !== undefined) {
          onFrame({ kind: "lost" });
        }
      },
    });
}

// One delivery as a frame: the list less each project that does not match, counted, or the list
// lost where the delivery is no list of projects even with its projects set aside.
function readProjectListFrame(payload: unknown): ProjectListFrame {
  if (validateProjectList(payload)) {
    return { kind: "list", projects: payload.projects, droppedCount: 0 };
  }
  // Set aside, the projects leave the rest of the delivery to be checked on its own.
  const rows: unknown =
    payload !== null && typeof payload === "object" ? Reflect.get(payload, "projects") : undefined;
  if (!Array.isArray(rows) || !validateProjectList({ ...(payload as object), projects: [] })) {
    recordUnreadable(checkFaultPaths(validateProjectList, payload));
    return { kind: "lost" };
  }
  const projects: ProjectListEntry[] = [];
  rows.forEach((row: unknown, index) => {
    if (validateProjectListEntry(row)) {
      projects.push(row);
      return;
    }
    recordUnreadable(
      checkFaultPaths(validateProjectListEntry, row).map((fault) => ({
        path: ["projects", index, ...fault.path],
      })),
    );
  });
  return { kind: "list", projects, droppedCount: rows.length - projects.length };
}

function recordUnreadable(issues: RefusedMemberIssues): void {
  recordRefusedMemberPaths({
    source: "services/daemon",
    kind: "notice-unreadable",
    subject: PROJECT_LIST_STREAM,
    issues,
  });
}
