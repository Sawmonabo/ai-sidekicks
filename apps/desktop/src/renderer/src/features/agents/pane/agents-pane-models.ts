// Who owns the Agents pane's reads, and for how long.
//
// LIFETIME, NOT REFRESH. Which method answers each read and what makes it ask again
// is `../agent-reads.ts`; this module owns how long a read lives, who is
// holding it, and what disposes it. The two change for different reasons — a lease
// policy moves when a view changes how it mounts, and a refresh story moves when
// the wire grows a signal.
//
// ONE OF EACH. A console shows one session at a time, and the child-link read answers
// that session's whole tree, so the models hold at most one roster and one linkage
// read. That is a bound stated by construction rather than a cap with a rationale:
// neither can grow. The roster is built once with the models and lives as long as
// they do; the linkage read is built on the first lease and disposed with the last.
//
// ACQUIRING A LINKAGE READ IS NOT STARTING ONE, AND THAT SPLIT IS THE POINT. Starting
// opens a subscription and arms a scheduler, which React's render phase may abandon
// or replay — an abandoned pass would leave a live read with no committed cleanup to
// release it, and a replayed one would dispose a read the committed tree is still
// showing. So the cache hands out a LEASE, the pane takes one from a mount effect
// and starts the read there, and the read is disposed when the last lease is given
// back. `start()` is idempotent, so a second holder joining a live read starts
// nothing twice.
//
// THE CLOCK COMES FROM THE BRIDGE. Under the fixture the scenario's frozen clock is
// the only clock the renderer reads, so every debounce here advances exactly when a
// scenario tick says it does.

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
 * One holder's grant of the session's child-link read.
 *
 * A value the taker owns rather than a flag on the models, so releasing is something
 * the effect that acquired it does for itself alone. The read is handed over
 * UNSTARTED: whoever takes the lease starts it from its own mount effect, and
 * `start()` is idempotent, so a second holder joining a live read starts nothing
 * twice.
 */
export interface ChildRunLinksLease {
  readonly read: ChildRunLinksRead;
  /**
   * Give this grant back.
   *
   * Idempotent, and terminal for this lease alone: a second call does nothing.
   */
  release: () => void;
}

/**
 * One session's Agents pane reads.
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
    // The window's clock, handed in: a clock of its own would put these reads on wall
    // time while the scenario's beats advance on frozen time.
    this.#clock = clock;
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

  /** Whether a linkage read is held. */
  public get holdsLinkage(): boolean {
    return this.#linkage !== undefined;
  }

  /** Linkage leases handed out and not given back. The lifetime assertion, counted. */
  public get outstandingLinkageLeaseCount(): number {
    return this.#outstandingLinkageLeaseCount;
  }

  /**
   * Take a lease on the session's child-link read, building it on the first ask.
   *
   * The read is NOT started here: starting opens a subscription and arms a
   * scheduler, and the view that takes the lease does both from a mount effect,
   * where a cleanup exists to undo them.
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
