// The live projects list: every project as the Projects page and the session list's project
// headers draw it, held in memory while a `repo.projectList` subscription is open and sent whole on
// each change. Session events that move a project's counts (a session made, archived, closed,
// converted, purged, or a run starting, waiting or ending) reach the feed through the log's
// all-sessions follow; a writer that changes the project rows or a run's held root without an
// event calls `refresh` after its write commits. Either way the list is read again once per turn
// of the event loop, however many changes named it, and sent only when it differs.

import { isDeepStrictEqual } from "node:util";

import type { EventCategory, EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { ProjectListEntry } from "@ai-sidekicks/contracts/project";

import type { ServiceLogWriter } from "../../daemon/service-log.js";
import type { EventLogService } from "../../events/log-service.js";
import { PURGE_RECEIPT_TYPE } from "../../events/session/purge.js";
import type { ProjectRecords } from "./records.js";

// The event categories whose events can move a project's session count, tally or running session.
const COUNTED_EVENT_CATEGORIES: ReadonlySet<EventCategory> = new Set<EventCategory>([
  "session_lifecycle",
  "run_lifecycle",
]);

/** What the feed reads and follows. */
export interface ProjectListFeedDeps {
  /** The project reads the list is built from. */
  readonly records: Pick<ProjectRecords, "readEntries">;
  /** The log whose committed events tell the feed a project's sessions changed. */
  readonly eventLog: Pick<EventLogService, "followAll">;
  /** Where a failed read of the list is written. */
  readonly writeServiceLog: ServiceLogWriter;
}

/**
 * One open subscription's side of the feed. Neither callback may throw: they run on the feed's
 * own turns, where no caller would receive the failure.
 */
export interface ProjectListListener {
  /** The whole list, after a change. */
  onList(projects: ProjectListEntry[]): void;
  /** The feed could not read the list; the listener is detached and hears nothing more. */
  onFailure(error: unknown): void;
}

/** The list as it stands when a listener opens it, and the detach that closes it. */
export interface ProjectListOpening {
  readonly projects: ProjectListEntry[];
  readonly detach: () => void;
}

/**
 * The daemon's one live projects list. Read from the rows when the first listener opens it and
 * dropped when the last one detaches; {@link ProjectListFeed.close} detaches it from the log.
 */
export class ProjectListFeed {
  readonly #records: Pick<ProjectRecords, "readEntries">;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #listeners = new Set<ProjectListListener>();
  readonly #detachFromLog: () => void;
  // Present exactly while a listener is open.
  #projects: ProjectListEntry[] | undefined;
  #pendingRead: ReturnType<typeof setImmediate> | undefined;

  constructor(deps: ProjectListFeedDeps) {
    this.#records = deps.records;
    this.#writeServiceLog = deps.writeServiceLog;
    this.#detachFromLog = deps.eventLog.followAll(
      (event) => {
        if (isCountedEvent(event)) this.refresh();
      },
      () => {
        this.refresh();
      },
    );
  }

  /**
   * Opens the list for `listener`: every project as it stands, and the detach. Every change from
   * then on reaches the listener as the whole list. Throws what the first read threw, with nothing
   * opened.
   */
  open(listener: ProjectListListener): ProjectListOpening {
    this.#projects ??= this.#records.readEntries();
    this.#listeners.add(listener);
    return {
      projects: this.#projects,
      detach: () => {
        this.#detach(listener);
      },
    };
  }

  /**
   * Reads the list again on the next turn and sends it when it changed. For a change written
   * without an event, called after the write commits; nothing is read while no listener is open.
   */
  refresh(): void {
    if (this.#projects === undefined) return;
    this.#pendingRead ??= setImmediate(() => {
      this.#pendingRead = undefined;
      this.#readAgain();
    });
  }

  /** Stops following the log, for the daemon's shutdown: open listeners hear nothing more. */
  close(): void {
    this.#detachFromLog();
    for (const listener of [...this.#listeners]) {
      this.#detach(listener);
    }
  }

  #detach(listener: ProjectListListener): void {
    if (!this.#listeners.delete(listener) || this.#listeners.size > 0) return;
    // Nobody reads the list now; the next open reads it again from the rows.
    this.#projects = undefined;
    if (this.#pendingRead !== undefined) {
      clearImmediate(this.#pendingRead);
      this.#pendingRead = undefined;
    }
  }

  #readAgain(): void {
    if (this.#projects === undefined) return;
    let projects: ProjectListEntry[];
    try {
      projects = this.#records.readEntries();
    } catch (error) {
      this.#fail(error);
      return;
    }
    if (isDeepStrictEqual(projects, this.#projects)) return;
    this.#projects = projects;
    for (const listener of this.#listeners) {
      listener.onList(projects);
    }
  }

  // No held list is current any more: every listener is detached and told, and the next open
  // reads the rows again.
  #fail(error: unknown): void {
    this.#writeServiceLog(
      "projects list: reading the projects again failed, so every listener was ended: " +
        (error instanceof Error ? error.message : String(error)),
    );
    const listeners = [...this.#listeners];
    for (const listener of listeners) {
      this.#detach(listener);
    }
    for (const listener of listeners) {
      listener.onFailure(error);
    }
  }
}

function isCountedEvent(event: EventEnvelope): boolean {
  return event.type === PURGE_RECEIPT_TYPE || COUNTED_EVENT_CATEGORIES.has(event.category);
}
