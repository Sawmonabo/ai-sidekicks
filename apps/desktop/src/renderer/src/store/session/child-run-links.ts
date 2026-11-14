// One child-run links read per open session, shared by every view that counts or lists the
// session's children: the composer's Sidekicks badge and the Sidekicks pane hold leases on the
// same read, so a change costs one tree read however many of them are drawn. The read is built by
// the first lease, with the builder its taker supplies, since `store/` builds no daemon read of its
// own, and disposed with the last lease given back.

import type { AgentChildRunLinkListResponse } from "@ai-sidekicks/contracts/orchestration";

import type { PushDrivenRead } from "../reads/push-driven.js";
import type { SessionStore } from "./store.js";

/** The session's child-run links read. */
export type SessionChildRunLinksRead = PushDrivenRead<AgentChildRunLinkListResponse>;

/** One holder's grant of the session's child-run links read, handed over unstarted. */
export interface ChildRunLinksLease {
  readonly read: SessionChildRunLinksRead;
  /** Give this grant back. Idempotent. */
  release: () => void;
}

/** Every open session's shared child-run links read, each held while any lease on it is. */
export class SessionChildRunLinks {
  readonly #heldBySession = new WeakMap<SessionStore, HeldChildRunLinks>();

  /**
   * Take a lease on `sessionStore`'s read, building it with `build` when none is held. The read is
   * not started here; the taker starts it from a mount effect.
   */
  public acquire(
    sessionStore: SessionStore,
    build: () => SessionChildRunLinksRead,
  ): ChildRunLinksLease {
    let held = this.#heldBySession.get(sessionStore);
    if (held === undefined) {
      held = { read: build(), leaseCount: 0 };
      this.#heldBySession.set(sessionStore, held);
    }
    const leased = held;
    leased.leaseCount += 1;
    let isReleased = false;
    return {
      read: leased.read,
      release: () => {
        if (isReleased) {
          return;
        }
        isReleased = true;
        leased.leaseCount -= 1;
        if (leased.leaseCount === 0 && this.#heldBySession.get(sessionStore) === leased) {
          this.#heldBySession.delete(sessionStore);
          leased.read.dispose();
        }
      },
    };
  }
}

/** The window's shared child-run links reads, one per open session. */
export const sessionChildRunLinks: SessionChildRunLinks = new SessionChildRunLinks();

/** One session's read and the leases on it not given back. */
interface HeldChildRunLinks {
  readonly read: SessionChildRunLinksRead;
  leaseCount: number;
}
