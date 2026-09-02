// Plan-013 T1.4 — the daemon-side binder for the four `timeline.*` methods.
//
// Spec coverage:
//   * `Spec-013 §Interfaces And Contracts` — the four operations.
//   * `docs/architecture/contracts/api-payload-contracts.md` §"Timeline
//     Method-Name Registry (Tier 8, Plan-013 T1.4)" — the canonical
//     method/procedure-type/schema table, whose code-side mirror is
//     `TIMELINE_METHOD_DESCRIPTORS` in `packages/contracts/src/timeline/`.
//   * Plan-007 CP-007-3 — the `MethodRegistry.register()` substrate this binds
//     against (the §5 substrate-vs-namespace carve-out: Plan-007 owns the
//     registry, each namespace plan owns its own registrations).
//
// ----------------------------------------------------------------------------
// Why a binder and not four `registry.register(...)` calls
// ----------------------------------------------------------------------------
//
// `MethodRegistry.register` takes the method NAME and its two schemas as
// independent arguments, so nothing stops a caller from registering
// `timeline.childRunExpand` against the reasoning-surface schemas: it
// typechecks, boots, and answers the wrong shape on the wire. The Tier-8 audit
// finding this task closes is exactly that class — the schemas resolved while
// the method strings did not — so binding them back together loosely would
// re-open it on the daemon side.
//
// `registerTimelineMethod` takes ONE descriptor. The name, the procedure type,
// the `mutating` flag, and the schema pair all travel together from the
// contracts registry, and the handler's parameter and result types are inferred
// FROM that descriptor, so a handler written against the wrong operation fails
// to compile rather than failing on the wire.
//
// ----------------------------------------------------------------------------
// Where the caller's principal comes from
// ----------------------------------------------------------------------------
//
// NOT from the request. None of the four request types declares a principal
// member, and each is `.strict()`, so a caller that supplies one is refused
// rather than having it stripped — the settled contract recorded at
// `api-payload-contracts.md` §"Authenticated Principal And Authorization
// Model" and on the `ReasoningSurfaceReadRequest` block beneath §Plan-013.
//
// A handler receives the principal through `HandlerContext`, the second
// parameter every `Handler<P, R>` takes (`@ai-sidekicks/contracts`,
// `jsonrpc-registry.ts`). That type carries `transportId` alone today and is
// documented there as widening ADDITIVELY, so the identity arrives on the
// context when Plan-007 widens it — never on the params object, which is the
// only thing a client controls. Phase 1 registers no handler, so there is no
// reader to point at yet; what it fixes is that no wire member exists for a
// later reader to be tempted by.
//
// ----------------------------------------------------------------------------
// Why the subscription binds through its own function
// ----------------------------------------------------------------------------
//
// `timeline.subscribe` has TWO schemas: the init ack the registry validates a
// handler's resolved value against, and the per-emission `TimelineRow` every
// `$/subscription/notify` frame carries. The contracts registry states both
// (`TimelineSubscriptionMethodBinding.emissionSchema`), but a handler bound the
// same way a query is would consume only the first — it receives the
// `StreamingPrimitive` itself and calls `createSubscription<T>(transportId,
// anySchema)` with a schema of its own choosing. Its ack still validates. Its
// emissions are then whatever that schema admits, and the canonical registry
// table's response column becomes a claim nothing checks.
//
// So the query binder is TYPED to refuse the subscription
// (`TimelineQueryMethodName` excludes it), and `registerTimelineSubscription`
// is the only way to bind it. That binder calls `createSubscription` itself,
// passing the descriptor's own `emissionSchema`, and hands the caller a
// `LocalSubscriptionProducer<TimelineRow>` — a producer whose `next()`
// validates against `TimelineRowSchema` before any frame leaves the daemon
// (the I-007-7 streaming analog). A Phase-2 producer cannot emit a
// non-`TimelineRow` value, because it never gets to choose the schema.
//
// ----------------------------------------------------------------------------
// No handlers are registered here
// ----------------------------------------------------------------------------
//
// Phase 1 ships contracts and this seam. The services these methods dispatch to
// arrive in Phase 2 (`timeline/timeline-projector.ts`) and Phase 3
// (`timeline/reasoning-surface-service.ts`,
// `timeline/child-run-summary-service.ts`), and each phase's binder calls
// through here with its own handler. A placeholder handler is deliberately NOT
// shipped: it would put a method on the wire that answers nothing, which a
// client cannot distinguish from a method that answers wrongly.

import { TIMELINE_METHOD_DESCRIPTORS, TIMELINE_SUBSCRIBE_METHOD } from "@ai-sidekicks/contracts";
import type {
  Handler,
  HandlerContext,
  LocalSubscriptionProducer,
  MethodRegistry,
  TimelineMethodRequest,
  TimelineMethodResponse,
  TimelineQueryMethodName,
  TimelineRow,
  TimelineSubscribeRequest,
  TimelineSubscribeResponse,
  ZodType,
} from "@ai-sidekicks/contracts";

import { createSubscriptionAckBarrier } from "../subscription-ack-barrier.js";

/**
 * What a caller supplies to bind one `timeline.*` method: the NAME, and a
 * handler whose types follow from it.
 *
 * There is deliberately no schema slot. The schemas are not an input.
 */
export interface TimelineMethodRegistration<MethodName extends TimelineQueryMethodName> {
  readonly method: MethodName;
  /**
   * The async handler. It is GUARANTEED a request that already passed the
   * canonical request schema (I-007-7), and its resolved value is validated
   * against the canonical response schema before it reaches the wire. Both
   * types are derived from `method`, so a handler written against a sibling
   * operation fails to compile.
   */
  readonly handler: Handler<TimelineMethodRequest<MethodName>, TimelineMethodResponse<MethodName>>;
}

/**
 * Bind one `timeline.*` method onto the supplied registry, resolving its
 * schemas from the canonical registry rather than accepting them.
 *
 * WHY THE SCHEMAS ARE NOT PARAMETERS. An earlier shape took the descriptor
 * itself, which made the right binding easy and the wrong one still
 * expressible: a caller could hand-build a descriptor literal pairing
 * `timeline.childRunExpand` with the reasoning-surface schemas, and it would
 * typecheck, boot, and answer the wrong shape on the wire. Making the binder
 * take one descriptor closed the loose three-argument form; it did not close
 * descriptor FORGERY.
 *
 * This form does. The only caller-supplied identity is the method name, and
 * both schemas are looked up from the frozen `TIMELINE_METHOD_DESCRIPTORS`
 * under that same name — so the name and the schemas cannot disagree, because
 * there is no second place for the caller to state them. The handler's
 * parameter and return types are derived from the same key through
 * `TimelineMethodContract`, so a handler written against a sibling operation
 * fails to compile rather than failing on the wire.
 *
 * @throws RegistryRegistrationError synchronously on a duplicate registration
 *   (I-007-6) or a name that fails the canonical format (I-007-9). All four
 *   `timeline.*` names are lowercase-root camelCase-tail and pass that gate;
 *   the registry test in `../__tests__/timeline-methods.test.ts` asserts it
 *   against the real `MethodRegistryImpl` rather than against the regex alone.
 *
 * Mutating flag: every timeline operation is a read — three idempotent `query`
 * rows and one `subscription` — so all four register `mutating: false` and pass
 * the version-mismatch gate when `DaemonHelloAck.compatible === false`, per
 * `Spec-007 §Fallback Behavior`'s read-only-continues rule. The flag comes from
 * the canonical descriptor, so no caller can raise it.
 *
 * `MethodName` is the QUERY subset. `timeline.subscribe` is refused at compile
 * time and binds through {@link registerTimelineSubscription}, which is the
 * only place its per-emission schema is consumed.
 */
export function registerTimelineMethod<MethodName extends TimelineQueryMethodName>(
  registry: MethodRegistry,
  registration: TimelineMethodRegistration<MethodName>,
): void {
  const descriptor = TIMELINE_METHOD_DESCRIPTORS[registration.method];
  // The one reconciliation point. `descriptor` is correctly typed per key, but
  // TypeScript cannot correlate a generic indexed access across three argument
  // positions at once, so it widens each to the four-way union. The cast asserts
  // what the map's own type already guarantees — schemas and handler share the
  // key `registration.method` — and it is confined to this single call, which is
  // why the identity test asserts the REGISTERED schemas are the canonical
  // objects by reference rather than trusting this line.
  registry.register(
    descriptor.method,
    descriptor.requestSchema,
    descriptor.responseSchema,
    registration.handler as Handler<unknown, unknown>,
    { mutating: descriptor.mutating },
  );
}

/**
 * The one capability `registerTimelineSubscription` needs from the Phase-2
 * streaming primitive, stated structurally rather than by importing the class.
 *
 * `StreamingPrimitive` satisfies this by shape, so the bootstrap orchestrator
 * passes the real instance unchanged; a test passes a recorder. Narrowing to
 * the single method also states the boundary: this binder allocates a
 * subscription and does nothing else with the primitive — it does not cancel
 * transports, does not reach the per-transport index, and cannot.
 */
export interface TimelineSubscriptionFactory {
  createSubscription<EmissionType>(
    transportId: number,
    valueSchema: ZodType<EmissionType>,
  ): LocalSubscriptionProducer<EmissionType>;
}

/**
 * What a caller supplies to bind `timeline.subscribe`.
 *
 * There is deliberately no emission-schema slot, for the same reason
 * {@link TimelineMethodRegistration} has no request/response slots: the schema
 * is not an input. It is read from the canonical descriptor, which is what
 * makes the `TimelineRow` guarantee hold against a producer that would rather
 * emit something else.
 */
export interface TimelineSubscriptionRegistration {
  /** The primitive instance the bootstrap orchestrator shares across handlers. */
  readonly streamingPrimitive: TimelineSubscriptionFactory;
  /**
   * Wire the timeline projection into the producer.
   *
   * Called once per accepted subscribe request, with the parsed request, a
   * producer that accepts `TimelineRow` and nothing else, and the handler
   * context. Implementations replay from `request.afterCursor` when present
   * and then live-tail, calling `producer.next(row)` for each row.
   *
   * A throw — session not found, an invalid cursor, a permission refusal —
   * cancels the just-allocated subscription before it propagates, so a failed
   * setup does not leave an entry stranded on the primitive's maps until the
   * transport closes. The registry's `dispatch()` wrapper then maps the throw
   * per I-007-8.
   */
  readonly attachProjection: (
    request: TimelineSubscribeRequest,
    producer: LocalSubscriptionProducer<TimelineRow>,
    context: HandlerContext,
  ) => void | Promise<void>;
}

/**
 * Bind `timeline.subscribe` onto the supplied registry, fixing the emission
 * schema from the canonical descriptor.
 *
 * The ack this returns is `{ subscriptionId }` — the shared
 * `SubscribeAckResponse` floor, validated by the descriptor's response schema
 * like any other result. Every subsequent row rides
 * `$/subscription/notify` and is validated against the descriptor's
 * `emissionSchema` inside `producer.next(...)` before the frame is written.
 *
 * ORDERING IS THIS BINDER'S, NOT THE CALLER'S. I-007-10 requires the init ack
 * to land before the first notification for that subscription. The producer
 * handed to `attachProjection` is a GATED facade over the real one: every
 * `next` and `complete` routes through the shared subscribe-init barrier
 * (`../subscription-ack-barrier.ts`), which buffers until the ack has been
 * written. Placing the barrier here rather than obliging `attachProjection` to
 * hold the line is deliberate — a projection cannot observe when its own
 * subscribe response reached the socket, so an obligation stated on that
 * member would be unverifiable by the party asked to meet it, and the failure
 * it guards is SILENT: a pre-ack frame hits the SDK's unknown-id drop branch,
 * so the rows vanish with no error raised anywhere. The facade also means a
 * Phase-2 projection cannot bypass the barrier by holding the producer it was
 * given.
 *
 * @throws RegistryRegistrationError synchronously on a duplicate registration
 *   (I-007-6) or a name that fails the canonical format (I-007-9).
 */
export function registerTimelineSubscription(
  registry: MethodRegistry,
  registration: TimelineSubscriptionRegistration,
): void {
  const descriptor = TIMELINE_METHOD_DESCRIPTORS[TIMELINE_SUBSCRIBE_METHOD];
  const handler: Handler<TimelineSubscribeRequest, TimelineSubscribeResponse> = async (
    request,
    context,
  ) => {
    const transportId = context.transportId;
    if (transportId === undefined) {
      // Per-connection streaming state needs a transport identity. A missing
      // one is a bootstrap or direct-call defect rather than a client protocol
      // violation, so it maps to an internal error — the posture
      // `registerSessionSubscribe` takes for the same condition.
      throw new Error(
        `${descriptor.method}: handler requires a transport identity on the handler context; ` +
          "per-connection subscription state cannot be allocated without one",
      );
    }
    // The emission schema comes from the descriptor and from nowhere else.
    // This is the line the whole binder exists for.
    const producer = registration.streamingPrimitive.createSubscription<TimelineRow>(
      transportId,
      descriptor.emissionSchema,
    );
    const barrier = createSubscriptionAckBarrier(producer, descriptor.method);
    // The gated facade. `next` and `complete` are ordered against the ack;
    // `cancel` and `onCancel` pass straight through, because teardown must not
    // wait on a response the caller may never get — a projection that fails
    // during setup has to be able to drain the entry it allocated.
    const gatedProducer: LocalSubscriptionProducer<TimelineRow> = {
      subscriptionId: producer.subscriptionId,
      next(row: TimelineRow): void {
        barrier.emit(row);
      },
      complete(): void {
        barrier.deferUntilAck(() => {
          producer.complete();
        });
      },
      cancel(): void {
        producer.cancel();
      },
      onCancel(fn: () => void): void {
        producer.onCancel(fn);
      },
    };
    try {
      await registration.attachProjection(request, gatedProducer, context);
    } catch (attachFailure) {
      // Atomicity: drain the entry this call allocated before the failure
      // escapes, so a refused subscribe leaves nothing behind on the
      // primitive's per-transport index. The barrier is never released on this
      // path, so nothing it buffered is ever scheduled or emitted.
      producer.cancel();
      throw attachFailure;
    }
    // Release AFTER a successful attach and BEFORE the return: the flush is
    // scheduled onto the check phase, which runs after the microtask that
    // writes this response.
    barrier.release();
    return { subscriptionId: producer.subscriptionId };
  };
  registry.register(
    descriptor.method,
    descriptor.requestSchema,
    descriptor.responseSchema,
    handler as Handler<unknown, unknown>,
    { mutating: descriptor.mutating },
  );
}
