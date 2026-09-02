// Shared subscribe-init ordering barrier for streaming JSON-RPC handlers.
//
// Ownership: this file sits at the `ipc/` substrate root rather than under
// `handlers/` because it is shared substrate — two namespaces bind streaming
// handlers through it, and a copy per namespace is exactly the drift this
// module exists to prevent. Plan-007 owns the directory and the streaming
// primitive; this module is authored by Plan-013 under CP-007-16 and hoisted
// on its second consumer, per the repo's structure rule that a helper needed
// by a second module is extracted at that second use rather than duplicated.
//
// Invariant it implements (canonical text in
// `docs/plans/007-local-ipc-and-daemon-control.md §Invariants`):
//   * I-007-10 — the subscribe-init response `{ subscriptionId }` reaches the
//     wire BEFORE the first `$/subscription/notify` frame for that
//     subscription.
//
// WHY A BARRIER IS REQUIRED RATHER THAN A CONVENTION. A subscribe handler's
// upstream may replay history SYNCHRONOUSLY inside the handler body — the
// Plan-001 Phase 5 projector contract permits replay-then-live-tail — so its
// emit callback can fire before the handler has even returned. The gateway
// writes the init response synchronously inside the dispatch promise's `.then`
// microtask, so an emission routed straight to the producer lands on the
// socket AHEAD of the response. The SDK registers a subscription in its
// inbound dispatcher map only after the init response settles, so every such
// frame hits the unknown-id silent-drop branch: the rows are gone, no error is
// raised anywhere, and the consumer sees a subscription that simply began
// late. Buffering is the fix, and it has to live below the handler because a
// handler cannot observe when its own response was written.
//
// WHY `setImmediate` AND NOT A MICROTASK. Any microtask queued from the
// handler's synchronous body drains in the SAME checkpoint, ahead of the
// dispatch resolution `.then` (FIFO within a checkpoint), so no number of
// `queueMicrotask` layers crosses the response. `setImmediate` schedules into
// the check phase, which runs after microtasks drain — the smallest primitive
// that crosses into the next event-loop phase. `process.nextTick` is wrong
// (higher priority than promise microtasks) and `setTimeout(fn, 0)` carries
// minimum-1ms timer semantics. One `setImmediate` boundary is sufficient.
//
// This barrier's correctness depends on the dispatch path resolving the
// response within microtasks — no `setImmediate` / `process.nextTick` deferral
// between handler return and the gateway's synchronous `socket.write`. A
// refactor introducing such deferral would silently reopen the hole; the
// wire-frame-ordering regression tests in `handlers/__tests__` are what catch
// it.

/**
 * The producer surface a barrier drives. Structurally satisfied by
 * `LocalSubscriptionProducer<EmissionType>` and deliberately narrower than it:
 * the barrier emits, cancels, and names the subscription in diagnostics, and
 * has no business with cancel-handler registration.
 */
export interface AckBarrierProducer<EmissionType> {
  readonly subscriptionId: string;
  next(value: EmissionType): void;
  cancel(): void;
}

/**
 * A one-way gate in front of a subscription producer.
 *
 * Every emission goes through {@link SubscriptionAckBarrier.emit}. Before
 * {@link SubscriptionAckBarrier.release} the value is buffered; after it, the
 * value is forwarded to the producer directly. `release` is called by the
 * handler once it is about to return the init response, and the flush itself
 * happens one event-loop phase later, after that response has been written.
 */
export interface SubscriptionAckBarrier<EmissionType> {
  /** Buffer or forward one value, depending on which side of the ack it is. */
  emit(value: EmissionType): void;
  /**
   * Order a non-value producer action — a stream completion, say — against the
   * same gate.
   *
   * Without this, a projection that finishes synchronously would write its
   * terminal frame ahead of the init response even though every row it
   * produced was correctly held back, and the consumer would see a stream end
   * before it began. Queued in emission order, so a completion never overtakes
   * the rows it terminates.
   */
  deferUntilAck(action: () => void): void;
  /**
   * Open the gate. Schedules the buffered flush past the init response.
   *
   * Idempotent, and deliberately so: a handler that releases twice must not
   * schedule two flushes over one buffer. Call it only on the success path —
   * a handler that throws during setup cancels the producer instead, and an
   * unreleased barrier schedules nothing.
   */
  release(): void;
}

/**
 * Build a barrier over `producer`.
 *
 * `methodName` prefixes the diagnostic a failed emission logs. It is the wire
 * method name (`session.subscribe`, `timeline.subscribe`) so an operator
 * reading the daemon's output can tell which surface produced the bad value.
 *
 * FAILURE POSTURE, IDENTICAL ON BOTH SIDES OF THE GATE. `producer.next` throws
 * `StreamingValidationError` when the value does not match the schema the
 * subscription was created with — a producer-side programmer error, not a
 * client fault. Both call paths run outside any dispatch error-mapping
 * wrapper: the live path fires from whatever turn the upstream event source
 * uses, and the flush fires from the check phase after the response has
 * already settled. An uncaught throw on either can terminate the daemon. So
 * both cancel the subscription cleanly — draining the primitive's maps so no
 * entry orphans — log a prefixed tripwire, and stop. The rest of the drain is
 * abandoned rather than continued: once canceled, further `next` calls are
 * documented no-ops anyway, and stopping avoids log spam from a producer
 * emitting many bad values. Swallowing keeps the daemon alive at the cost of
 * this one subscription's tail, which is the right trade — the wire client is
 * innocent and the transport's other subscriptions must keep working.
 *
 * TRIPWIRE: the diagnostics below use `console.error` because the daemon has
 * no structured logger today. Both sites flip to it when one lands.
 */
export function createSubscriptionAckBarrier<EmissionType>(
  producer: AckBarrierProducer<EmissionType>,
  methodName: string,
): SubscriptionAckBarrier<EmissionType> {
  // One ordered queue of thunks rather than a value array plus a flag per
  // action kind: emissions and completions must drain in the order the
  // projection produced them, and two queues cannot express that interleaving.
  const pendingActions: (() => void)[] = [];
  let released = false;
  let scheduled = false;

  const runOrQueue = (action: () => void, failureKind: "live-tail" | "replay"): void => {
    if (!released) {
      pendingActions.push(action);
      return;
    }
    try {
      action();
    } catch (err) {
      producer.cancel();
      console.error(
        `[${methodName}] ${failureKind} event validation/emission failed for subscriptionId=${producer.subscriptionId}; subscription canceled`,
        err,
      );
    }
  };

  return {
    emit(value: EmissionType): void {
      runOrQueue(() => {
        producer.next(value);
      }, "live-tail");
    },

    deferUntilAck(action: () => void): void {
      runOrQueue(action, "live-tail");
    },

    release(): void {
      if (scheduled) {
        return;
      }
      scheduled = true;
      setImmediate(() => {
        released = true;
        try {
          for (const action of pendingActions) {
            action();
          }
        } catch (err) {
          producer.cancel();
          console.error(
            `[${methodName}] replay event validation/emission failed for subscriptionId=${producer.subscriptionId}; subscription canceled`,
            err,
          );
        }
        pendingActions.length = 0;
      });
    },
  };
}
