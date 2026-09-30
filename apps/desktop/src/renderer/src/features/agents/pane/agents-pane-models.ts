// Who owns the Agents pane's reads, and for how long; `../agent-reads.ts` owns which method
// answers each read and what makes it ask again. A console shows one session, so the models hold
// one roster (built with them) and at most one linkage read (built on the first lease, disposed
// with the last). Acquiring a linkage read does not start it: render may be abandoned or
// replayed, so the pane starts it from a mount effect, where a cleanup exists. `start()` is
// idempotent. The clock comes from the bridge, so the fixture's frozen clock drives every debounce.

import type { Clock } from "@renderer/lib/clock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { type SessionSubject } from "@renderer/store/subject-scoped/session-subject.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";
import {
  createAgentList,
  createChildRunLinks,
  type AgentsPaneCalls,
  type AgentListRead,
  type ChildRunLinksRead,
} from "../agent-reads.js";

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
 * One session's Agents pane reads. A class because it owns the linkage cache's lifetime and
 * teardown.
 */
export class AgentsPaneModels {
  /**
   * The exact bridge and store this set was built for. The store is held, not reduced to a
   * `sessionId`, because child links and refused creates arrive as session events.
   */
  public readonly subject: SessionSubject;
  public readonly roster: AgentListRead;

  readonly #clock: Clock;
  readonly #calls: AgentsPaneCalls;
  #linkage: ChildRunLinksRead | undefined;
  #outstandingLinkageLeaseCount = 0;
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
    this.roster = createAgentList(sessionStore, this.#clock, calls.listAgents);
    this.roster.start();
  }

  /** The session these reads answer for, read off the subject so there is one copy of it. */
  public get sessionId(): string {
    return this.subject.sessionStore.sessionId;
  }

  /** Whether a linkage read is held. */
  public get holdsLinkage(): boolean {
    return this.#linkage !== undefined;
  }

  /** Linkage leases handed out and not given back. */
  public get outstandingLinkageLeaseCount(): number {
    return this.#outstandingLinkageLeaseCount;
  }

  /**
   * Take a lease on the session's child-link read, building it on the first ask. The read is
   * not started here; the taker starts it from a mount effect.
   */
  public acquireLinkage(): ChildRunLinksLease {
    const linkage =
      this.#linkage ??
      createChildRunLinks(this.subject.sessionStore, this.#clock, this.#calls.readChildRunLinks);
    this.#linkage = linkage;
    this.#outstandingLinkageLeaseCount += 1;
    return this.#leaseOn(linkage);
  }

  /** Release every read. Terminal. */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.roster.dispose();
    this.#releaseLinkage();
  }

  /** One lease over the held read, counted down once however often it is released. */
  #leaseOn(linkage: ChildRunLinksRead): ChildRunLinksLease {
    let isReleased = false;
    return {
      read: linkage,
      release: () => {
        if (isReleased) {
          return;
        }
        isReleased = true;
        this.#outstandingLinkageLeaseCount -= 1;
        if (this.#outstandingLinkageLeaseCount <= 0) {
          this.#releaseLinkage();
        }
      },
    };
  }

  /** Dispose whatever linkage read is held, at most once. Safe with none. */
  #releaseLinkage(): void {
    const held = this.#linkage;
    this.#linkage = undefined;
    this.#outstandingLinkageLeaseCount = 0;
    held?.dispose();
  }
}
