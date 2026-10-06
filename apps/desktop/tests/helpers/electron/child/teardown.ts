// The single ordered teardown one spawned child settles through. It sits below the spawner
// (`spawner.ts`) and imports only the lifetime object.
//
// The question it answers is an order: a child holds a resource, the platform may refuse to kill
// that child, and the resource must come off disk after the last attempt, not between two of them.
// That needs exactly one teardown per spawned child, registered by the spawner and nothing else.

import { DISPOSAL_ATTEMPTS, TERMINATION_GRACE_MS, type ManagedChild } from "./managed.js";

/** What a spawn releases once its child is gone: the resource that child held. */
export type ChildRelease = () => void;

/**
 * The one teardown a spawned child settles through: every attempt, then the release.
 *
 * Vitest runs settle-time callbacks in registration stack order, so a release registered by the
 * caller after the spawner's disposer would run first: under a platform that refused the kill it
 * would remove the profile under a live browser (on Windows the removal fails on open handles),
 * and the spawner's disposer would kill the tree afterwards with no removal behind it. So one
 * owner sequences every attempt and the release is the single act after the last, passed as a
 * spawn argument so no second disposer exists. `#settled` guards re-entrancy: a settlement driven
 * twice releases once.
 *
 * Each attempt is a single `dispose`, so this loop and `disposeUntilKillDelivered` cannot
 * multiply into nine synchronous tree kills against a bound of three. Returning early on
 * `hasClosed` keeps an ordinary teardown one call long.
 */
export class OrderedChildTeardown {
  readonly #managed: ManagedChild;
  readonly #release: ChildRelease | undefined;
  #settled = false;

  constructor(managed: ManagedChild, release: ChildRelease | undefined) {
    this.#managed = managed;
    this.#release = release;
  }

  /** Asks until the child has closed or the bound is spent, then releases. */
  async settle(): Promise<void> {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    for (let attempt = 0; attempt < DISPOSAL_ATTEMPTS; attempt += 1) {
      // The first disposal is unconditional, even after `close`: it also releases an armed
      // escalation timer, and a pending timer is a claim on a worker being torn down.
      this.#managed.dispose();
      await this.#whenChildIsGone();
      if (this.#managed.hasClosed) {
        break;
      }
    }
    this.#release?.();
  }

  /**
   * Resolves once the child has closed, or once the bound is spent, whichever is first.
   *
   * Waits for `close`, not `exit`: `exit` fires when the process ends, `close` when every
   * inherited stdio stream is released too, and in between a descendant holding the child's
   * stdout is still running. Releasing then races processes holding files in the resource; on
   * Windows an open handle makes the removal fail. `close` fires at most once, so the
   * already-fired arm avoids waiting out the bound on every teardown, and the spent-bound arm
   * removes its listener because the loop retries.
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
      }, TERMINATION_GRACE_MS);
      child.once("close", onClosed);
    });
  }
}
