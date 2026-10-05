// The mutating calls the daemon has taken and not yet finished. The gateway runs several calls at
// once, so a write a client asked for can still be on its way when a flush or a stop arrives; the
// flush waits for those calls before it answers, and a stop, for a bounded time, before it closes
// the database.

import type {
  Handler,
  HandlerContext,
  MethodRegistry,
  RegisterOptions,
  ZodType,
} from "@ai-sidekicks/contracts/jsonrpc/registry";

/**
 * Records every mutating call dispatched through the registry it wraps. A call is recorded once its
 * handler has started, so a handler that waits at its start waits only for the calls before it,
 * never for itself.
 */
export class InFlightMutations {
  readonly #pending = new Set<Promise<unknown>>();

  /** Returns a registry that dispatches through `inner` and records its mutating calls. */
  wrap(inner: MethodRegistry): MethodRegistry {
    return new RecordingRegistry(inner, (method, dispatch) => {
      if (inner.isMutating(method) === true) {
        this.#record(dispatch);
      }
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
    let boundTimer: ReturnType<typeof setTimeout> | undefined;
    const boundReached = new Promise<"bound">((resolve) => {
      boundTimer = setTimeout(() => {
        resolve("bound");
      }, boundMs);
    });
    try {
      const outcome = await Promise.race([Promise.allSettled(pending), boundReached]);
      return outcome === "bound" ? pending.filter((call) => this.#pending.has(call)).length : 0;
    } finally {
      clearTimeout(boundTimer);
    }
  }

  #record(dispatch: Promise<unknown>): void {
    this.#pending.add(dispatch);
    const forget = (): void => {
      this.#pending.delete(dispatch);
    };
    dispatch.then(forget, forget);
  }
}

// Delegates everything to the inner registry; only `dispatch` records the call.
class RecordingRegistry implements MethodRegistry {
  readonly #inner: MethodRegistry;
  readonly #record: (method: string, dispatch: Promise<unknown>) => void;

  constructor(inner: MethodRegistry, record: (method: string, dispatch: Promise<unknown>) => void) {
    this.#inner = inner;
    this.#record = record;
  }

  register<P, R>(
    method: string,
    paramsSchema: ZodType<P>,
    resultSchema: ZodType<R>,
    handler: Handler<P, R>,
    opts?: RegisterOptions,
  ): void {
    // `opts` is forwarded only when present (exactOptionalPropertyTypes).
    if (opts === undefined) {
      this.#inner.register(method, paramsSchema, resultSchema, handler);
    } else {
      this.#inner.register(method, paramsSchema, resultSchema, handler, opts);
    }
  }

  dispatch(method: string, params: unknown, ctx: HandlerContext): Promise<unknown> {
    const dispatch = this.#inner.dispatch(method, params, ctx);
    this.#record(method, dispatch);
    return dispatch;
  }

  has(method: string): boolean {
    return this.#inner.has(method);
  }

  isMutating(method: string): boolean | undefined {
    return this.#inner.isMutating(method);
  }
}
