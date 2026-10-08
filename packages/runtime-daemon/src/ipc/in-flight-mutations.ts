// The mutating calls the daemon has taken and not yet finished. The gateway runs several calls at
// once, so a write a client asked for can still be on its way when a flush or a stop arrives; the
// flush waits for those calls before it answers, and a stop, for a bounded time, before it closes
// the database.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";

import { waitWithin } from "../bounded-wait.js";
import { DelegatingRegistry } from "./registry.js";

/**
 * Records every mutating call dispatched through the registry it wraps. A call is recorded once its
 * handler has started, so a handler that waits at its start waits only for the calls before it,
 * never for itself.
 */
export class InFlightMutations {
  readonly #pending = new Set<Promise<unknown>>();

  /** Returns a registry that dispatches through `inner` and records its mutating calls. */
  wrap(inner: MethodRegistry): MethodRegistry {
    return new DelegatingRegistry(inner, (method, params, ctx) => {
      const dispatch = inner.dispatch(method, params, ctx);
      if (inner.isMutating(method) === true) {
        this.#record(dispatch);
      }
      return dispatch;
    });
  }

  /**
   * Resolves once every mutating call taken before this call has finished, answered or failed. A
   * call taken afterward does not extend the wait, so a busy daemon still answers its flush.
   */
  async waitForPending(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }

  /**
   * As `waitForPending`, giving up after `boundMs`; resolves with how many of those calls were
   * still running then, `0` when every one finished in time.
   */
  async waitForPendingWithin(boundMs: number): Promise<number> {
    const pending = [...this.#pending];
    const hasSettled = await waitWithin(Promise.allSettled(pending), boundMs);
    return hasSettled ? 0 : pending.filter((call) => this.#pending.has(call)).length;
  }

  #record(dispatch: Promise<unknown>): void {
    this.#pending.add(dispatch);
    const forget = (): void => {
      this.#pending.delete(dispatch);
    };
    dispatch.then(forget, forget);
  }
}
