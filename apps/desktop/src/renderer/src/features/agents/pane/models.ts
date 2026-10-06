// Who owns the Agents pane's reads, and for how long; `../reads.ts` owns which method answers
// each read and what makes it ask again. A console shows one session, so the models hold one agent
// list (built with them) and at most one child-run links read (built on the first lease, disposed
// with the last). Acquiring a child-run links read does not start it: render may be abandoned or
// re-run, so the pane starts it from a mount effect, where a cleanup exists. `start()` is
// idempotent. The clock comes from the bridge, so the fixture's frozen clock drives every debounce.

import type { Clock } from "#renderer/lib/clock.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { type SessionSubject } from "#renderer/store/session/subject.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import {
  createAgentList,
  createChildRunLinks,
  type AgentsPaneCalls,
  type AgentListRead,
  type ChildRunLinksRead,
} from "../reads.js";

/**
 * One holder's grant of the session's child-link read, handed over unstarted. Releasing is
 * something the acquiring effect does for itself alone.
 */
export interface ChildRunLinksLease {
  readonly read: ChildRunLinksRead;
  /** Give this grant back. Idempotent. */
  release: () => void;
}

/**
 * One session's Agents pane reads. A class because it owns the child-run links cache's lifetime and
 * teardown.
 */
export class AgentsPaneModels {
  /**
   * The exact bridge and store this set was built for. The store is held, not reduced to a
   * `sessionId`, because child links and refused creates arrive as session events.
   */
  public readonly subject: SessionSubject;
  public readonly agentList: AgentListRead;

  readonly #clock: Clock;
  readonly #calls: AgentsPaneCalls;
  #childRunLinks: ChildRunLinksRead | undefined;
  #outstandingChildRunLinksLeaseCount = 0;
  #disposed = false;

  public constructor(
    bridge: PlatformBridge,
    clock: Clock,
    sessionStore: SessionStore,
    calls: AgentsPaneCalls,
  ) {
    this.subject = { bridge, sessionStore };
    this.#calls = calls;
    // The window's clock, so these reads do not run on wall time while scenarios use frozen time.
    this.#clock = clock;
    this.agentList = createAgentList(sessionStore, this.#clock, calls.listAgents);
    this.agentList.start();
  }

  /** The session these reads answer for, read off the subject so there is one copy of it. */
  public get sessionId(): string {
    return this.subject.sessionStore.sessionId;
  }

  /** Whether a child-run links read is held. */
  public get holdsChildRunLinks(): boolean {
    return this.#childRunLinks !== undefined;
  }

  /** Child-run links leases handed out and not given back. */
  public get outstandingChildRunLinksLeaseCount(): number {
    return this.#outstandingChildRunLinksLeaseCount;
  }

  /**
   * Take a lease on the session's child-link read, building it on the first ask. The read is
   * not started here; the taker starts it from a mount effect.
   */
  public acquireChildRunLinks(): ChildRunLinksLease {
    const childRunLinks =
      this.#childRunLinks ??
      createChildRunLinks(this.subject.sessionStore, this.#clock, this.#calls.readChildRunLinks);
    this.#childRunLinks = childRunLinks;
    this.#outstandingChildRunLinksLeaseCount += 1;
    return this.#leaseOn(childRunLinks);
  }

  /** Release every read. Terminal. */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.agentList.dispose();
    this.#releaseChildRunLinks();
  }

  /** One lease over the held read, counted down once however often it is released. */
  #leaseOn(childRunLinks: ChildRunLinksRead): ChildRunLinksLease {
    let isReleased = false;
    return {
      read: childRunLinks,
      release: () => {
        if (isReleased) {
          return;
        }
        isReleased = true;
        this.#outstandingChildRunLinksLeaseCount -= 1;
        if (this.#outstandingChildRunLinksLeaseCount <= 0) {
          this.#releaseChildRunLinks();
        }
      },
    };
  }

  /** Dispose whatever child-run links read is held, at most once. Safe with none. */
  #releaseChildRunLinks(): void {
    const held = this.#childRunLinks;
    this.#childRunLinks = undefined;
    this.#outstandingChildRunLinksLeaseCount = 0;
    held?.dispose();
  }
}
