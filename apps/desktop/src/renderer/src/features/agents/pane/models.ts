// Who owns the Agents pane's leases on the session's child-run links read, and for how long;
// `../reads.ts` owns which method answers it and what makes it ask again. The read itself is the
// session's shared one (`store/session/child-run-links.ts`), which the composer's badge leases
// too; the agent list is the session's shared one, which the columns read themselves. Acquiring a
// lease does not start the read: render may be abandoned or re-run, so the pane starts it from a
// mount effect, where a cleanup exists. `start()` is idempotent. The clock comes from the bridge,
// so the fixture's frozen clock drives every debounce.

import type { Clock } from "#renderer/lib/clock.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { type SessionSubject } from "#renderer/store/session/subject.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { createChildRunLinks } from "#renderer/services/daemon/child-run-links.js";
import {
  sessionChildRunLinks,
  type ChildRunLinksLease,
} from "#renderer/store/session/child-run-links.js";
import type { AgentsPaneCalls } from "../reads.js";

/**
 * One session's Agents pane reads. A class because it owns its leases' lifetime and teardown.
 */
export class AgentsPaneModels {
  /**
   * The exact bridge and store this set was built for. The store is held, not reduced to a
   * `sessionId`, because child links and refused creates arrive as session events.
   */
  public readonly subject: SessionSubject;

  readonly #bridge: PlatformBridge;
  readonly #clock: Clock;
  readonly #calls: AgentsPaneCalls;
  // The leases this set handed out and that were not given back.
  readonly #leases = new Set<ChildRunLinksLease>();
  #disposed = false;

  public constructor(
    bridge: PlatformBridge,
    clock: Clock,
    sessionStore: SessionStore,
    calls: AgentsPaneCalls,
  ) {
    this.subject = { bridge, sessionStore };
    this.#bridge = bridge;
    this.#calls = calls;
    // The window's clock, so these reads do not run on wall time while scenarios use frozen time.
    this.#clock = clock;
  }

  /** The session these reads answer for, read off the subject so there is one copy of it. */
  public get sessionId(): string {
    return this.subject.sessionStore.sessionId;
  }

  /** Whether this set holds a lease on the child-run links read. */
  public get holdsChildRunLinks(): boolean {
    return this.#leases.size > 0;
  }

  /** Child-run links leases this set handed out and that were not given back. */
  public get outstandingChildRunLinksLeaseCount(): number {
    return this.#leases.size;
  }

  /**
   * Take a lease on the session's shared child-link read, building it on the first ask. The read
   * is not started here; the taker starts it from a mount effect.
   */
  public acquireChildRunLinks(): ChildRunLinksLease {
    const { sessionStore } = this.subject;
    const shared = sessionChildRunLinks.acquire(sessionStore, () =>
      createChildRunLinks(this.#bridge, sessionStore, this.#clock, this.#calls.readChildRunLinks),
    );
    const lease: ChildRunLinksLease = {
      read: shared.read,
      release: () => {
        this.#leases.delete(lease);
        shared.release();
      },
    };
    this.#leases.add(lease);
    return lease;
  }

  /** Give back every lease this set holds. Terminal. */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const lease of [...this.#leases]) {
      lease.release();
    }
  }
}
