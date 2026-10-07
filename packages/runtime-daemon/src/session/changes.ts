// The changes a person makes to one session: rename, archive, reactivate, close, pin and mute.
// Each reads the session's facts, decides, and appends its event with a guard that those facts
// still hold, so a change that raced another is decided again on what landed. A change that finds
// the session already as it asks appends nothing; a closed session, or one being purged, takes no
// change.

import type { Database, Statement } from "better-sqlite3";

import {
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type {
  SessionLifecycleChangePayload,
  SessionMarkChangePayload,
  SessionRenamedPayload,
} from "@ai-sidekicks/contracts/session/events";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  SESSION_CHANGE_REFUSED_CODE,
  type SessionRenameRequest,
  type SessionRenameResponse,
  type SessionState,
} from "@ai-sidekicks/contracts/session/methods";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import type { WriteStatement } from "../database/statement.js";
import { WriteRefusedError } from "../database/writer.js";
import type { EventLogService } from "../events/log-service.js";
import { DaemonDomainError } from "../ipc/domain-error.js";
import { translateDriverError } from "../ipc/handlers/driver/requests.js";
import { SessionNotFoundError } from "../ipc/session-errors.js";
import { KeyedLock } from "../keyed-lock.js";
import type { ProviderDriver } from "../provider/driver/contract.js";
import { DriverUnavailableError, type ProviderRegistry } from "../provider/driver/registry.js";
import type { RuntimeBindingStore } from "../provider/runtime-binding-store.js";
import { mintUuidV7 } from "../uuid-v7.js";

const SESSION_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// The facts of a session's row a change decides from.
interface SessionFacts {
  readonly state: SessionState;
  readonly name: string | null;
  readonly pinnedAt: string | null;
  readonly mutedAt: string | null;
}

// The event a change appends, or nothing when the session already is as the change asks.
type SessionChangeEvent =
  | {
      readonly type: Extract<
        SessionEventType,
        "session.archived" | "session.reactivated" | "session.closed"
      >;
      readonly payload: SessionLifecycleChangePayload;
    }
  | {
      readonly type: Extract<
        SessionEventType,
        "session.pinned" | "session.unpinned" | "session.muted" | "session.unmuted"
      >;
      readonly payload: SessionMarkChangePayload;
    }
  | { readonly type: "session.renamed"; readonly payload: SessionRenamedPayload }
  | undefined;

type SessionMark = "pin" | "mute";

// Holds only while every fact the change was decided from is as it was read.
const FACTS_UNCHANGED_SQL = `SELECT 1 FROM sessions
  WHERE id = @sessionId AND state = @state AND name IS @name
    AND pinned_at IS @pinnedAt AND muted_at IS @mutedAt`;

/** What the session changes read, append and end through. */
export interface SessionChangesDeps {
  /** The read-only connection the session's facts and runs are read on. */
  readonly reader: Database;
  /** The append path each change's event goes through. */
  readonly events: Pick<EventLogService, "append">;
  /** The live drivers a close ends the session's provider leg through. */
  readonly providers: Pick<ProviderRegistry, "lookup">;
  /** The bindings that say which drivers ran the session's runs. */
  readonly runtimeBindings: Pick<RuntimeBindingStore, "findByRuns">;
  /** The clock that stamps each event. Defaults to the system clock. */
  readonly now?: () => Date;
}

/**
 * Renames, archives, reactivates, closes, pins and mutes sessions. A session that does not exist
 * is refused with {@link SessionNotFoundError}; a closed one with `session.already_closed`, and
 * one being purged with `session.change_refused`.
 */
export class SessionChanges {
  /**
   * The lock every session-wide transition holds for its whole run, keyed by session id: archive,
   * reactivate, close and convert take it, so one never interleaves with another on the same
   * session.
   */
  readonly lock: KeyedLock<SessionId> = new KeyedLock<SessionId>(canonicalizeUuid);

  readonly #events: Pick<EventLogService, "append">;
  readonly #providers: Pick<ProviderRegistry, "lookup">;
  readonly #runtimeBindings: Pick<RuntimeBindingStore, "findByRuns">;
  readonly #now: () => Date;
  readonly #selectFacts: Statement<[string], SessionFacts>;
  readonly #selectRunIds: Statement<[string], { readonly runId: string }>;

  constructor(deps: SessionChangesDeps) {
    this.#events = deps.events;
    this.#providers = deps.providers;
    this.#runtimeBindings = deps.runtimeBindings;
    this.#now = deps.now ?? (() => new Date());
    this.#selectFacts = deps.reader.prepare(
      `SELECT state, name, pinned_at AS pinnedAt, muted_at AS mutedAt
         FROM sessions
        WHERE id = ?`,
    );
    // Every run of the session names itself on its lifecycle events.
    this.#selectRunIds = deps.reader.prepare(
      `SELECT DISTINCT json_extract(payload, '$.runId') AS runId
         FROM session_events
        WHERE session_id = ? AND category = 'run_lifecycle'
          AND json_extract(payload, '$.runId') IS NOT NULL`,
    );
  }

  /**
   * The person's rename: `null` clears the name. A rename to the name the session holds appends
   * nothing. Never touches the session's branch or worktree.
   */
  async rename(request: SessionRenameRequest): Promise<SessionRenameResponse> {
    await this.#change(request.sessionId, (facts) => {
      refuseUnchangeableSession(request.sessionId, facts.state);
      return facts.name === request.name
        ? undefined
        : renamedEvent(request.sessionId, request.name, facts.name, "user");
    });
    return { sessionId: request.sessionId, name: request.name };
  }

  /**
   * Names the session only while it is unnamed and takes changes, deciding that inside the write,
   * so a name written in the meantime always wins. Resolves with whether it named the session.
   */
  async nameUnnamed(sessionId: SessionId, name: string): Promise<boolean> {
    return this.#change(sessionId, (facts) =>
      isUnchangeable(facts.state) || facts.name !== null
        ? undefined
        : renamedEvent(sessionId, name, null, "auto"),
    );
  }

  /**
   * Moves an active session into the archived ones, leaving its provider process as it was. A
   * session still `provisioning` is refused with `session.change_refused`.
   */
  async archive(sessionId: SessionId): Promise<void> {
    await this.lock.run(sessionId, async () => {
      await this.#change(sessionId, (facts) => {
        refuseUnchangeableSession(sessionId, facts.state);
        refuseProvisioningSession(sessionId, facts.state);
        return facts.state === "archived"
          ? undefined
          : lifecycleEvent("session.archived", sessionId, facts.state, "archived");
      });
    });
  }

  /** Returns an archived session to the live list; a closed one is refused. */
  async reactivate(sessionId: SessionId): Promise<void> {
    await this.lock.run(sessionId, async () => {
      await this.#change(sessionId, (facts) => {
        refuseUnchangeableSession(sessionId, facts.state);
        return facts.state === "archived"
          ? lifecycleEvent("session.reactivated", sessionId, "archived", "active")
          : undefined;
      });
    });
  }

  /**
   * Closes the session: ends its provider leg through each driver that ran it, then appends
   * `session.closed`. The session stays readable. Closing a closed session does nothing; one still
   * `provisioning` or being purged is refused with `session.change_refused`. A session one of whose
   * runs a driver this daemon has not registered ran is refused with `driver.unavailable` before
   * any leg is ended, so it never reads closed while that provider may still run it.
   */
  async close(sessionId: SessionId): Promise<void> {
    await this.lock.run(sessionId, async () => {
      const facts = this.#readFacts(sessionId);
      if (facts.state === "closed") {
        return;
      }
      refuseUnchangeableSession(sessionId, facts.state);
      refuseProvisioningSession(sessionId, facts.state);
      // The leg ends first, so a session never reads closed while its provider still runs.
      await this.#endProviderLeg(sessionId);
      await this.#change(sessionId, (current) => {
        if (current.state === "closed") {
          return undefined;
        }
        // A purge may mark the session while its provider leg is ending.
        refuseUnchangeableSession(sessionId, current.state);
        return lifecycleEvent("session.closed", sessionId, current.state, "closed");
      });
    });
  }

  /** Pins the session to the top of its group; a pinned session keeps its first pin time. */
  async pin(sessionId: SessionId): Promise<void> {
    await this.#setMark(sessionId, "pin", true);
  }

  /** Unpins the session. */
  async unpin(sessionId: SessionId): Promise<void> {
    await this.#setMark(sessionId, "pin", false);
  }

  /** Mutes the session's notifications. */
  async mute(sessionId: SessionId): Promise<void> {
    await this.#setMark(sessionId, "mute", true);
  }

  /** Unmutes the session's notifications. */
  async unmute(sessionId: SessionId): Promise<void> {
    await this.#setMark(sessionId, "mute", false);
  }

  async #setMark(sessionId: SessionId, mark: SessionMark, isSet: boolean): Promise<void> {
    await this.#change(sessionId, (facts) => {
      refuseUnchangeableSession(sessionId, facts.state);
      const isSetNow = (mark === "pin" ? facts.pinnedAt : facts.mutedAt) !== null;
      if (isSetNow === isSet) {
        return undefined;
      }
      const payload: SessionMarkChangePayload = { sessionId, at: this.#now().toISOString() };
      if (mark === "pin") {
        return { type: isSet ? "session.pinned" : "session.unpinned", payload };
      }
      return { type: isSet ? "session.muted" : "session.unmuted", payload };
    });
  }

  // Decides on the session's facts and appends what was decided, guarded on those facts. A refused
  // guard means another change landed first, so the change is decided again on what landed.
  // Resolves with whether an event was appended.
  async #change(
    sessionId: SessionId,
    decide: (facts: SessionFacts) => SessionChangeEvent,
  ): Promise<boolean> {
    for (;;) {
      const facts = this.#readFacts(sessionId);
      const change = decide(facts);
      if (change === undefined) {
        return false;
      }
      try {
        await this.#events.append(
          {
            id: mintUuidV7(),
            sessionId,
            occurredAt: this.#now().toISOString(),
            category: "session_lifecycle",
            type: change.type,
            actor: null,
            payload: { ...change.payload },
            version: SESSION_EVENT_VERSION,
          },
          { transactionalPrelude: [factsUnchangedStatement(sessionId, facts)] },
        );
        return true;
      } catch (error) {
        if (error instanceof WriteRefusedError && error.statementIndex === 0) {
          continue;
        }
        throw error;
      }
    }
  }

  #readFacts(sessionId: SessionId): SessionFacts {
    const facts = this.#selectFacts.get(sessionId);
    if (facts === undefined) {
      throw new SessionNotFoundError("This daemon holds no such session.", { sessionId });
    }
    return facts;
  }

  // Each driver that ran one of the session's runs closes the session's leg; both drivers treat a
  // session they hold nothing for as already closed. Every driver is looked up before any leg is
  // ended, so a missing one refuses the close with nothing ended.
  async #endProviderLeg(sessionId: SessionId): Promise<void> {
    const runIds = this.#selectRunIds.all(sessionId).map((row) => row.runId);
    const driverNames = new Set(
      this.#runtimeBindings.findByRuns(runIds).map((binding) => binding.driverName),
    );
    const drivers: ProviderDriver[] = [];
    for (const driverName of driverNames) {
      drivers.push(this.#registeredDriver(driverName));
    }
    for (const driver of drivers) {
      await driver.closeSession({ sessionId });
    }
  }

  #registeredDriver(driverName: ProviderName): ProviderDriver {
    const driver = this.#providers.lookup(driverName);
    if (driver === undefined) {
      translateDriverError(new DriverUnavailableError(driverName));
    }
    return driver;
  }
}

/**
 * Refuses a change to a session that takes none: a closed one with `session.already_closed`, and
 * one being purged with `session.change_refused`.
 */
export function refuseUnchangeableSession(sessionId: SessionId, state: SessionState): void {
  if (state === "closed") {
    throw new DaemonDomainError("The session is closed and cannot be changed.", {
      code: "session.already_closed",
      detail: { sessionId },
    });
  }
  if (state === "purge_requested") {
    throw changeRefused(sessionId, state);
  }
}

// Only an active or archived session is archived or closed; a provisioning one is finished
// by its create instead.
function refuseProvisioningSession(sessionId: SessionId, state: SessionState): void {
  if (state === "provisioning") {
    throw changeRefused(sessionId, state);
  }
}

function isUnchangeable(state: SessionState): boolean {
  return state === "closed" || state === "purge_requested";
}

function changeRefused(sessionId: SessionId, state: SessionState): DaemonDomainError {
  return new DaemonDomainError("The session's state does not take that change.", {
    code: SESSION_CHANGE_REFUSED_CODE,
    detail: { sessionId, state },
  });
}

function lifecycleEvent(
  type: "session.archived" | "session.reactivated" | "session.closed",
  sessionId: SessionId,
  previousState: SessionState,
  newState: SessionState,
): SessionChangeEvent {
  return { type, payload: { sessionId, previousState, newState } };
}

function renamedEvent(
  sessionId: SessionId,
  name: string | null,
  previousName: string | null,
  origin: SessionRenamedPayload["origin"],
): SessionChangeEvent {
  return {
    type: "session.renamed",
    payload: {
      sessionId,
      name,
      ...(previousName === null ? {} : { previousName }),
      origin,
    },
  };
}

function factsUnchangedStatement(sessionId: SessionId, facts: SessionFacts): WriteStatement {
  return {
    sql: FACTS_UNCHANGED_SQL,
    bindings: { sessionId, ...facts },
    expectedRowCount: 1,
  };
}
