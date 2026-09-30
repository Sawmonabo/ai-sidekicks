// Streaming primitive: the server side of `LocalSubscriptionProducer<T>`, emitting
// `$/subscription/notify` frames and handling `$/subscription/cancel`.
//
// - Every emitted value is validated against the subscription's `valueSchema` before the frame is
//   sent; a failure throws `StreamingValidationError`.
// - The wire schemas, the branded `SubscriptionId` and the producer interface live in
//   `@ai-sidekicks/contracts` because this package does not depend on `zod`.
// - The gateway's own send path only accepts response envelopes, so notifications go to a `send`
//   callback the caller connects to the per-transport write path.
// - A subscription id is a `crypto.randomUUID()` string, which satisfies `SubscriptionIdSchema`.

import type {
  Handler,
  JsonRpcNotification,
  LocalSubscriptionProducer,
  MethodRegistry,
  SubscriptionCancelParams,
  SubscriptionCancelResult,
  SubscriptionId,
  SubscriptionNotifyParams,
  ZodType,
} from "@ai-sidekicks/contracts";
import {
  JSONRPC_VERSION,
  SUBSCRIPTION_CANCEL_METHOD,
  SUBSCRIPTION_NOTIFY_METHOD,
  SubscriptionCancelParamsSchema,
  SubscriptionCancelResultSchema,
} from "@ai-sidekicks/contracts";

/**
 * Thrown synchronously from `next(value)` when the value fails the subscription's `valueSchema`: a
 * producer bug the client cannot recover from. Thrown rather than returned, since a notification
 * has no response to carry it. `issues` is the raw zod issue array, typed `unknown`.
 */
export class StreamingValidationError extends Error {
  readonly subscriptionId: SubscriptionId;
  readonly issues: ReadonlyArray<unknown> | undefined;

  constructor(subscriptionId: SubscriptionId, message: string, issues?: ReadonlyArray<unknown>) {
    super(message);
    this.name = "StreamingValidationError";
    this.subscriptionId = subscriptionId;
    this.issues = issues;
  }
}

/** Only `canceled` fires `onCancel` handlers; `complete` is a natural end the producer knows. */
type SubscriptionState = "active" | "complete" | "canceled";

/** One live subscription; `T` is erased to `unknown` so one map holds every subscription. */
interface SubscriptionEntry {
  readonly transportId: number;
  readonly valueSchema: ZodType<unknown>;
  /** Moves only `active` -> `complete` or `canceled`; later teardown calls are no-ops. */
  state: SubscriptionState;
  /** Emptied after firing, so a handler registered after cancel is not replayed. */
  readonly onCancelHandlers: Array<() => void>;
}

/**
 * `send` receives each outbound notification and must not throw; the caller frames and writes it.
 * `registry` gets `$/subscription/cancel` at construction, so a duplicate registration fails
 * before any listener binds.
 */
export interface StreamingPrimitiveOptions {
  readonly send: (transportId: number, frame: JsonRpcNotification<unknown>) => void;
  readonly registry: MethodRegistry;
}

/**
 * Server-side streaming primitive: `createSubscription<T>` hands a handler such as
 * `session.subscribe` a producer to emit into. The caller must call `cleanupTransport` on every
 * disconnect, or subscriptions of closed connections leak.
 */
export class StreamingPrimitive {
  readonly #send: (transportId: number, frame: JsonRpcNotification<unknown>) => void;
  readonly #subscriptions: Map<SubscriptionId, SubscriptionEntry>;
  // Reverse index, so `cleanupTransport` touches only that transport's subscriptions.
  readonly #subscriptionsByTransport: Map<number, Set<SubscriptionId>>;

  constructor(options: StreamingPrimitiveOptions) {
    this.#send = options.send;
    this.#subscriptions = new Map();
    this.#subscriptionsByTransport = new Map();
    // Throws if `$/subscription/cancel` is already registered (two primitives on one registry).
    this.#registerCancelHandler(options.registry);
  }

  /**
   * Creates a subscription owned by `transportId`, whose values are validated against
   * `valueSchema`, and returns the producer to emit into. Only the owning transport can cancel it.
   */
  createSubscription<T>(
    transportId: number,
    valueSchema: ZodType<T>,
  ): LocalSubscriptionProducer<T> {
    // A v4 UUID, not `mintUuidV7`: the id lives only in this process for one transport and
    // nothing sorts ids.
    const subscriptionId = crypto.randomUUID() as SubscriptionId;

    const entry: SubscriptionEntry = {
      transportId,
      valueSchema: valueSchema as ZodType<unknown>,
      state: "active",
      onCancelHandlers: [],
    };
    this.#subscriptions.set(subscriptionId, entry);

    let bucket = this.#subscriptionsByTransport.get(transportId);
    if (bucket === undefined) {
      bucket = new Set<SubscriptionId>();
      this.#subscriptionsByTransport.set(transportId, bucket);
    }
    bucket.add(subscriptionId);

    const send = this.#send;
    const subscriptions = this.#subscriptions;
    const removeFromTransport = (id: SubscriptionId): void => {
      const e = subscriptions.get(id);
      if (e === undefined) {
        return;
      }
      const t = this.#subscriptionsByTransport.get(e.transportId);
      if (t !== undefined) {
        t.delete(id);
        if (t.size === 0) {
          // Drop empty buckets so closed subscriptions leave no dead entries.
          this.#subscriptionsByTransport.delete(e.transportId);
        }
      }
    };

    const fireOnCancelHandlers = (): void => {
      // A throwing handler must not stop the others or block teardown.
      for (const handler of entry.onCancelHandlers) {
        try {
          handler();
        } catch {
          // Intentional swallow, see above.
        }
      }
      entry.onCancelHandlers.length = 0;
    };

    const subscription: LocalSubscriptionProducer<T> = {
      subscriptionId,
      next(value: T): void {
        if (entry.state !== "active") {
          return;
        }
        const parsed = entry.valueSchema.safeParse(value);
        if (!parsed.success) {
          throw new StreamingValidationError(
            subscriptionId,
            `LocalSubscriptionProducer.next: value validation failed for subscriptionId ${JSON.stringify(subscriptionId)} (programmer error — the producer returned a value that does not match the registered valueSchema; daemon refuses to emit malformed data on the wire)`,
            parsed.error.issues,
          );
        }
        const params: SubscriptionNotifyParams<unknown> = {
          subscriptionId,
          value: parsed.data,
        };
        const frame: JsonRpcNotification<SubscriptionNotifyParams<unknown>> = {
          jsonrpc: JSONRPC_VERSION,
          method: SUBSCRIPTION_NOTIFY_METHOD,
          params,
        };
        send(entry.transportId, frame);
      },
      complete(): void {
        // State only: no frame is sent and `onCancel` handlers do not fire.
        if (entry.state !== "active") {
          return;
        }
        entry.state = "complete";
        removeFromTransport(subscriptionId);
        subscriptions.delete(subscriptionId);
      },
      cancel(): void {
        // Server-initiated: sends no frame but fires `onCancel` handlers. Leaves the maps first so
        // a re-entrant handler sees the post-cancel state.
        if (entry.state !== "active") {
          return;
        }
        entry.state = "canceled";
        removeFromTransport(subscriptionId);
        subscriptions.delete(subscriptionId);
        fireOnCancelHandlers();
      },
      onCancel(fn: () => void): void {
        // Fires at once on an already canceled subscription, so a late-acquired resource is freed.
        // It is the only handler running and its registrant is the caller, so a failure reaches
        // the registrant.
        if (entry.state === "canceled") {
          fn();
          return;
        }
        // A completed subscription drops the handler so unconditional registration is safe.
        if (entry.state === "complete") {
          return;
        }
        entry.onCancelHandlers.push(fn);
      },
    };
    return subscription;
  }

  /**
   * Cancels every subscription owned by a closed transport, firing `onCancel` handlers. The caller
   * must call it from the gateway's `onDisconnect` hook.
   */
  cleanupTransport(transportId: number): void {
    const bucket = this.#subscriptionsByTransport.get(transportId);
    if (bucket === undefined) {
      return;
    }
    // Snapshot first: an `onCancel` handler may re-enter the primitive and mutate the bucket.
    const subscriptionIds = [...bucket];
    this.#subscriptionsByTransport.delete(transportId);
    for (const subscriptionId of subscriptionIds) {
      // One subscription's failure must not stop the cleanup of its siblings.
      try {
        const entry = this.#subscriptions.get(subscriptionId);
        if (entry === undefined) {
          continue;
        }
        // Mark canceled and remove before firing, as `cancel()` does.
        entry.state = "canceled";
        this.#subscriptions.delete(subscriptionId);
        for (const handler of entry.onCancelHandlers) {
          try {
            handler();
          } catch {
            // Per-handler isolation, as in `fireOnCancelHandlers`.
          }
        }
        entry.onCancelHandlers.length = 0;
      } catch {
        // Best-effort: disconnect cleanup continues with the remaining subscriptions.
      }
    }
  }

  /**
   * Cancels a subscription by id, firing its `onCancel` handlers, and returns whether it existed.
   * Transport ownership is checked by the registered cancel handler, not here.
   */
  cancelSubscription(subscriptionId: SubscriptionId): boolean {
    const entry = this.#subscriptions.get(subscriptionId);
    if (entry === undefined) {
      return false;
    }
    entry.state = "canceled";
    const bucket = this.#subscriptionsByTransport.get(entry.transportId);
    if (bucket !== undefined) {
      bucket.delete(subscriptionId);
      if (bucket.size === 0) {
        this.#subscriptionsByTransport.delete(entry.transportId);
      }
    }
    this.#subscriptions.delete(subscriptionId);
    for (const handler of entry.onCancelHandlers) {
      try {
        handler();
      } catch {
        // Per-handler isolation, as in `fireOnCancelHandlers`.
      }
    }
    entry.onCancelHandlers.length = 0;
    return true;
  }

  /**
   * Registers `$/subscription/cancel` with `mutating: false`: cancelling only reclaims a wire
   * resource, and the version gate must let a client whose negotiation went incompatible still
   * clean up. A cancel from a non-owning transport returns `{ canceled: false }`, the same as an
   * unknown id, so it does not reveal subscriptions on other transports.
   */
  #registerCancelHandler(registry: MethodRegistry): void {
    const handler: Handler<SubscriptionCancelParams, SubscriptionCancelResult> = async (
      params,
      ctx,
    ) => {
      const entry = this.#subscriptions.get(params.subscriptionId);
      if (entry === undefined) {
        return { canceled: false };
      }
      // Also refuses a call with no transport id (direct dispatch); tests call
      // `cancelSubscription`.
      if (ctx.transportId !== entry.transportId) {
        return { canceled: false };
      }
      const removed = this.cancelSubscription(params.subscriptionId);
      return { canceled: removed };
    };

    registry.register(
      SUBSCRIPTION_CANCEL_METHOD,
      SubscriptionCancelParamsSchema,
      SubscriptionCancelResultSchema,
      handler,
      { mutating: false },
    );
  }
}
