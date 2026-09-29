// Who owns the agent console's reads, and for how long.
//
// LIFETIME, NOT REFRESH. Which method answers each read and what makes it ask again
// is `../agent-reads.ts`; this module owns how long a read lives, who is
// holding it, and what disposes it. The two change for different reasons — a lease
// policy moves when a surface changes how it mounts, and a refresh story moves when
// the wire grows a signal.
//
// A CACHE OF ONE, TWICE OVER. A console shows one session at a time and one run's
// links at a time, so both caches hold exactly one entry and switching disposes what
// they held. That is a bound stated by construction rather than a cap with a
// rationale: neither can grow. The roster is built once with the models and lives as
// long as they do; one run's child links are built on demand and cached one at a
// time — asking for a different run disposes the previous read.
//
// ACQUIRING A LINKAGE READ IS NOT STARTING ONE, AND THAT SPLIT IS THE POINT. Starting
// opens a subscription and arms a scheduler, which React's render phase may abandon
// or replay — an abandoned pass would leave a live read with no committed cleanup to
// release it, and a replayed one would dispose a read the committed tree is still
// showing. So the cache hands out a LEASE, the surface takes one from a mount effect
// and starts the read there, and the read is disposed when the last lease is given
// back. `start()` is idempotent, so a second holder joining a live read starts
// nothing twice.
//
// THE CLOCK COMES FROM THE BRIDGE. Under the fixture the scenario's frozen clock is
// the only clock the renderer reads, so every debounce here advances exactly when a
// scenario tick says it does.

import type { ConsoleClock } from "@renderer/lib/clock.js";
import { consoleClockFor } from "@renderer/services/platform/hooks/useClock.js";
import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { type SessionSubject } from "@renderer/console/seats/index.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";
import {
  createAgentList,
  createChildRunLinks,
  type AgentConsoleCalls,
  type AgentListRead,
  type ChildRunLinksRead,
} from "../agent-reads.js";

/**
 * One holder's grant of a parent run's child-link read.
 *
 * A value the taker owns rather than a flag on the models, so releasing is something
 * the effect that acquired it can do without naming the run it acquired for — which
 * matters exactly when the run has since changed underneath it. The read is handed
 * over UNSTARTED: whoever takes the lease starts it from its own mount effect, and
 * `start()` is idempotent, so a second holder joining a live read starts nothing
 * twice.
 */
export interface ChildRunLinksLease {
  readonly read: ChildRunLinksRead;
  /**
   * Give this grant back.
   *
   * Idempotent, and terminal for this lease alone: a second call does nothing, and a
   * lease on a read the models have already replaced releases nothing, because the
   * read it named was disposed with the run it belonged to.
   */
  release: () => void;
}

/**
 * One session's agent-console reads.
 *
 * A class rather than a record: it owns the linkage cache's lifetime and its
 * teardown, and `apps/desktop/AGENTS.md` puts stateful logic in a class with private
 * fields.
 */
export class AgentsPaneModels {
  /**
   * The exact bridge and store this set was built for.
   *
   * Public because it is what {@link useAgentsPaneModels} compares at render, and
   * the store is held rather than reduced to a `sessionId` for a second reason: a
   * child link and a refused create both arrive as session events, so the linkage
   * read needs the stream itself and not the name of the session it belongs to.
   */
  public readonly subject: SessionSubject;
  public readonly roster: AgentListRead;

  readonly #clock: ConsoleClock;
  readonly #calls: AgentConsoleCalls;
  #linkage: HeldChildRunLinkage | undefined;
  #outstandingLinkageLeaseCount = 0;
  #disposed = false;

  public constructor(bridge: ConsoleBridge, sessionStore: SessionStore, calls: AgentConsoleCalls) {
    this.subject = { bridge, sessionStore };
    this.#calls = calls;
    // Through the platform service's clock rather than resolved here. The rule — a
    // fixture bridge running an engine shares that engine's FROZEN clock, and only a
    // running engine owns one — is `consoleClockFor`'s, and a second copy of it
    // is how a window ends up with stores on wall time while its scenario beats advance
    // on frozen time, which is the exact drift that seam was minted to end.
    this.#clock = consoleClockFor(bridge);
    this.roster = createAgentList(sessionStore, this.#clock, calls.listAgents);
    this.roster.start();
  }

  /**
   * The session these reads answer for.
   *
   * Read off the subject rather than copied beside it: a second field holding the
   * same string is a second answer to which session this set belongs to, and the
   * one the guard consults would not be the one a caller composed a request from.
   */
  public get sessionId(): string {
    return this.subject.sessionStore.sessionId;
  }

  /** Which run the held linkage answers for, or `undefined` while none is held. */
  public get heldLinkageParentRunId(): string | undefined {
    return this.#linkage?.parentRunId;
  }

  /** Linkage leases handed out and not given back. The lifetime assertion, counted. */
  public get outstandingLinkageLeaseCount(): number {
    return this.#outstandingLinkageLeaseCount;
  }

  /**
   * Take a lease on one parent run's child-link read, building it on the first ask.
   *
   * Asking for a different run disposes the previous read, so no scheduler and no
   * subscription survives a run the console has left. The read is NOT started here:
   * starting opens a subscription and arms a scheduler, and the surface that takes
   * the lease does both from a mount effect, where a cleanup exists to undo them.
   */
  public acquireLinkage(parentRunId: string): ChildRunLinksLease {
    const held = this.#linkage;
    if (held !== undefined && held.parentRunId === parentRunId) {
      this.#outstandingLinkageLeaseCount += 1;
      return this.#leaseOn(held);
    }
    this.#releaseLinkage();
    const linkage: HeldChildRunLinkage = {
      parentRunId,
      read: createChildRunLinks(
        this.subject.sessionStore,
        parentRunId,
        this.#clock,
        this.#calls.readChildRunLinks,
      ),
    };
    this.#linkage = linkage;
    this.#outstandingLinkageLeaseCount = 1;
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

  /**
   * One lease over one held read, keyed on that read's own identity.
   *
   * The identity check is what makes a stale release harmless: React runs a mount's
   * cleanup after the effect that re-keyed the run has already replaced the held
   * read, and a counter decremented by that cleanup would take the NEW run's read
   * down with it.
   */
  #leaseOn(linkage: HeldChildRunLinkage): ChildRunLinksLease {
    let isReleased = false;
    return {
      read: linkage.read,
      release: () => {
        if (isReleased || this.#linkage !== linkage) {
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
    held?.read.dispose();
  }
}

/** The linkage read the models hold, with the run it answers for. */
interface HeldChildRunLinkage {
  readonly parentRunId: string;
  readonly read: ChildRunLinksRead;
}
