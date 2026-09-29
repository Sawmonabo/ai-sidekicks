// The single ordered teardown one spawned child settles through.
//
// Split out of `electron-child.ts` rather than left inside it because that
// module is the SPAWN door — the one file under `test/` allowed to reach
// `spawn` — and sequencing a settlement is a second job in the same file. It
// sits BELOW the door rather than beside it: it imports the lifetime object
// and nothing else, so the door can arm it and the spawn-and-release door can
// stay a door.
//
// It answers one question, and the question is an ORDER: a child holds a
// resource, the platform may refuse to kill that child, and the resource must
// come off disk after the LAST attempt rather than between two of them. What
// makes that answerable at all is that there is exactly one of these per
// spawned child and the door registers it and nothing else.

import { DISPOSAL_ATTEMPTS, type ManagedElectronChild } from "./managed-electron-child.js";

/** What a spawn releases once its child is gone: the resource that child held. */
export type ChildRelease = () => void;

/**
 * The ONE teardown a spawned child settles through: every attempt, then the release.
 *
 * THE LEAK THIS CLOSES IS AN ORDERING, NOT A MISSING CALL. The release used to
 * be a settle-time registration of the CALLER's, necessarily made after the one
 * the spawn door armed — and Vitest runs settle-time callbacks in registration
 * STACK order, so the caller's ran FIRST. Under a platform that refused the
 * kill, that disposer spent its whole attempt bound against a child that was
 * never going to close, removed the profile under a live browser, and only then
 * did the door's own disposer take its turn and kill the tree: a FOURTH
 * termination after the remover, with no removal anywhere behind it. On Windows
 * the directory still had live handles in it when the removal ran, so it failed
 * outright and the locked profile outlived the run.
 *
 * So one owner sequences every attempt and the release is the single act after
 * the last one. A later attempt is impossible BY CONSTRUCTION rather than by a
 * guard that hopes: the door registers this and nothing else, and the release
 * travels as a spawn argument, so there is no second disposer that could hold a
 * kill for after the removal. `#settled` is re-entrancy and not the ordering
 * claim — a settlement driven twice releases once.
 *
 * ONE DISPOSAL PER WAIT, AND THE DECLARED BOUND IS THE TOTAL. Each attempt is a
 * single `dispose`, so this loop and `disposeUntilKillDelivered` cannot multiply
 * into nine synchronous tree kills against a constant that says three. Returning
 * early on `hasClosed` is what keeps an ordinary teardown one call long: the
 * bound is what a refusal costs, not what every test pays.
 */
export class OrderedChildTeardown {
  readonly #managed: ManagedElectronChild;
  readonly #exitWaitMs: number;
  readonly #release: ChildRelease | undefined;
  #settled = false;

  constructor(
    managed: ManagedElectronChild,
    exitWaitMs: number,
    release: ChildRelease | undefined,
  ) {
    this.#managed = managed;
    this.#exitWaitMs = exitWaitMs;
    this.#release = release;
  }

  /** Ask until the child has closed or the bound is spent, then release. */
  async settle(): Promise<void> {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    for (let attempt = 0; attempt < DISPOSAL_ATTEMPTS; attempt += 1) {
      // The FIRST disposal is unconditional, even against a child whose `close`
      // has already been delivered, because signalling is not all it does: it
      // also releases an armed escalation timer, and a pending timer is a claim
      // on a worker that is being torn down.
      this.#managed.dispose();
      await this.#whenChildIsGone();
      if (this.#managed.hasClosed) {
        break;
      }
    }
    this.#release?.();
  }

  /**
   * Resolve once the child has closed, or once the bound is spent — whichever first.
   *
   * `close` IS THE EVENT, AND AN EXIT CODE IS NOT A PROXY FOR IT. `exit` fires
   * when the process ends, `close` when every stdio stream inherited from it has
   * been released as well. Between the two, a descendant that inherited the
   * child's stdout is still running — the shim-and-browser shape this module's
   * header describes, and the ordinary shape here. Releasing in that window
   * races processes still holding files inside the resource; on POSIX the
   * unlink mostly succeeds anyway and hides the bug, and on Windows an open
   * handle makes the removal fail outright.
   *
   * The already-fired arm is not an optimisation: `close` is delivered at most
   * once, so a listener registered after it would wait out the whole bound on
   * every ordinary teardown. The spent-bound arm REMOVES its listener, because
   * the loop above comes back: without it a retried disposal leaves one dead
   * closure per refused attempt on a child that is still running.
   */
  async #whenChildIsGone(): Promise<void> {
    if (this.#managed.hasClosed) {
      return;
    }
    const { child } = this.#managed;
    await new Promise<void>((resolve) => {
      const onClosed = (): void => {
        clearTimeout(bound);
        resolve();
      };
      const bound = setTimeout(() => {
        child.removeListener("close", onClosed);
        resolve();
      }, this.#exitWaitMs);
      child.once("close", onClosed);
    });
  }
}
