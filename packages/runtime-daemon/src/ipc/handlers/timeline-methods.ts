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

import {
  TIMELINE_CHILD_RUN_EXPAND_METHOD,
  TIMELINE_METHOD_DESCRIPTORS,
  TIMELINE_READ_METHOD,
  TIMELINE_REASONING_SURFACE_READ_METHOD,
  TIMELINE_SUBSCRIBE_METHOD,
} from "@ai-sidekicks/contracts";
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

import { RegistryDispatchError } from "../registry.js";
import {
  createSubscriptionAckBarrier,
  type AckBarrierProducer,
} from "../subscription-ack-barrier.js";

// ----------------------------------------------------------------------------
// Request correlation: the checks no schema can perform
// ----------------------------------------------------------------------------
//
// The registry validates a handler's resolved value against the response
// schema and NOTHING ELSE — it never shows the schema the parsed request. That
// is the right boundary for the registry (a schema that needed the request
// would stop being a schema), and it leaves behind the defects that are only
// visible when request and response are held together. Two of them are live
// here.
//
// A SELF-CONSISTENT REPLY ABOUT THE WRONG SUBJECT. A `timeline.read` for
// session A can return a page of rows every one of which is a valid
// `TimelineRow` from session B; a `timeline.childRunExpand` for run A can
// return a response naming run B whose entries all agree with the run it
// names. Both parse. Both reach the client, which has no way to tell that the
// aggregate answers a question it did not ask — the request id it correlates
// on says the reply is its own.
//
// A REPLY WHOSE MEANING DEPENDS ON WHAT WAS ASKED. An `available` reasoning
// surface with no entries is a true statement about a continuation that has
// reached the end, and a false one about a first read — the same bytes, two
// meanings, separated only by whether the request carried an `afterCursor`.
// The contract encodes what it can (the continuing arm carries a non-empty
// floor because it is the arm that can loop a client) and stops exactly where
// the request leaves scope.
//
// The refusal is therefore an INTERNAL error and not a client error: the caller
// asked a well-formed question, and the daemon assembled an answer that does
// not answer it. It reuses the registry's own `invalid_result` code, which is
// exactly the condition ("the handler returned a value that does not match what
// this method may return") one step further out than the registry can see —
// mapping to `-32603` with `data.type: "invalid_result"` and the offending
// coordinates in `data.fields.issues`, indistinguishable in shape from a
// schema-side result failure. No new error code is minted.

/**
 * One request/response disagreement, shaped like a Zod issue so it rides
 * `data.fields.issues` identically to a schema-side result-validation failure
 * and a client reading that field needs no second parser.
 */
interface RequestCorrelationViolation {
  readonly code: "custom";
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * The per-method request-correlation check, keyed by method so each arm is
 * typed against its own request and response rather than against the four-way
 * union.
 *
 * The mapped type is indexed by the same generic the binder carries, so the
 * lookup in {@link registerTimelineMethod} correlates without a cast — the
 * same property `TIMELINE_METHOD_DESCRIPTORS` relies on.
 */
type TimelineRequestCorrelationCheck<MethodName extends TimelineQueryMethodName> = (
  request: TimelineMethodRequest<MethodName>,
  result: TimelineMethodResponse<MethodName>,
) => readonly RequestCorrelationViolation[];

/**
 * SHAPE FIRST, CORRELATION SECOND — and this check owns only the second.
 *
 * The correlation check runs inside the handler wrapper, which is one step BEFORE
 * the registry validates the result against the response schema, so it is
 * handed values that may not be a response at all: a handler that resolved a
 * sibling operation's shape, or `undefined`. Reading `result.entries.length`
 * off one of those throws a `TypeError` out of the dispatch promise and turns
 * a clean `invalid_result` envelope into an unmapped internal failure — the
 * check would have destroyed the diagnostic it exists beside.
 *
 * So every arm below tests the shape it reads — down to each element it
 * dereferences, not merely the container that holds them — and returns NO
 * violations when that shape is absent. This is not defensiveness for its own
 * sake: a result
 * that does not match the response schema is the registry's finding to report,
 * with the offending path and the real reason, one step later. Two reporters
 * for one defect would leave the worse message on the wire.
 *
 * BOUNDED REPORTING. A read page holds up to `TIMELINE_READ_LIMIT_MAX` rows,
 * and every one of them could be cross-scope. Reporting each would put an
 * unbounded issue array on an error frame that the framer bounds absolutely —
 * an oversized error reply is the one failure the substrate cannot report, so
 * a diagnostic that grows with the defect is the wrong shape. The first
 * offending entry is reported with its index, and the message states how many
 * entries disagreed in total, which is what an operator needs to tell a single
 * stray row from a whole page from the wrong session.
 */
const TIMELINE_REQUEST_CORRELATION_CHECKS: {
  readonly [MethodName in TimelineQueryMethodName]: TimelineRequestCorrelationCheck<MethodName>;
} = {
  [TIMELINE_READ_METHOD]: (request, result) => {
    if (!Array.isArray(result?.entries)) {
      return [];
    }
    // PER-ELEMENT, not just per-array. `entries` being an array says nothing
    // about what is IN it, and the declared element type is a promise the
    // handler has not yet been held to: a page holding `null`, or an object
    // with no `sessionId`, satisfies `Array.isArray` and then throws a bare
    // `TypeError` out of the comparison below — which is the one outcome this
    // whole check is built to avoid, since an exception on the dispatch path
    // replaces the structured `invalid_result` envelope with an unmapped
    // internal failure carrying no issue paths at all.
    //
    // A page with even one unreadable element defers ENTIRELY rather than
    // reporting the readable ones: a malformed entry is a shape defect, the
    // response schema is its reporter, and this check throwing first would
    // pre-empt that reporter with a strictly worse message. Same rule as the
    // array guard above, applied one level down.
    if (!result.entries.every((entry) => typeof entry?.sessionId === "string")) {
      return [];
    }
    const firstOffendingIndex = result.entries.findIndex(
      (entry) => entry.sessionId !== request.sessionId,
    );
    if (firstOffendingIndex === -1) {
      return [];
    }
    const offendingCount = result.entries.filter(
      (entry) => entry.sessionId !== request.sessionId,
    ).length;
    const firstOffendingEntry = result.entries[firstOffendingIndex];
    return [
      {
        code: "custom",
        path: ["entries", firstOffendingIndex, "sessionId"],
        message:
          `entry sessionId ${JSON.stringify(firstOffendingEntry?.sessionId)} does not match the ` +
          `requested session ${JSON.stringify(request.sessionId)} (${String(offendingCount)} of ` +
          `${String(result.entries.length)} entries disagree): the reply is a valid page of ` +
          "another session's history, which the caller cannot distinguish from its own",
      },
    ];
  },
  // The reasoning surface has no SUBJECT to cross-check, and that omission is
  // deliberate rather than overlooked: `ReasoningSurfaceReadResponse` carries
  // no `runId` and no `sessionId` on any of its four states — it is a
  // reasoning body plus an availability verdict — so there is no member on the
  // reply that could name the wrong run. Adding one purely to check it would
  // mint a wire member whose only reader is this guard.
  //
  // What it does have is the FIRST-PAGE floor, which is a correlation rule and
  // not a subject one. `available` with zero entries renders as a reasoning
  // surface that exists and shows nothing — pixel-identical to `unavailable`
  // while asserting the opposite, the state collapse the availability
  // vocabulary exists to prevent. That is a defect on a first read and the
  // correct answer on a continuation whose cursor already sat at the end, so
  // the response schema cannot decide it: the request is what separates the
  // two, and this is the only layer holding both. The schema carries the half
  // it can see (the continuing arm's non-empty floor, which is about looping);
  // this carries the half it cannot.
  [TIMELINE_REASONING_SURFACE_READ_METHOD]: (request, result) => {
    if (request?.afterCursor !== undefined) {
      return [];
    }
    if (result?.availability !== "available") {
      return [];
    }
    // Shape first here too: a non-array `reasoningEntries` is the response
    // schema's finding, not this one's.
    if (!Array.isArray(result.reasoningEntries) || result.reasoningEntries.length > 0) {
      return [];
    }
    return [
      {
        code: "custom",
        path: ["reasoningEntries"],
        message:
          "a first reasoning read carried no cursor, so an empty available surface has no " +
          "continuation to explain it: the client renders a surface that exists and shows " +
          "nothing, which is indistinguishable from the unavailable state while asserting the " +
          "opposite — a producer with nothing to serve must answer with the state that is true " +
          "(unavailable, compacted, or policy_redacted) rather than with an empty page",
      },
    ];
  },
  [TIMELINE_CHILD_RUN_EXPAND_METHOD]: (request, result) => {
    if (typeof result?.runId !== "string") {
      return [];
    }
    if (result.runId === request.runId) {
      // Entry-level run attribution needs no separate check here: the response
      // schema already pins every run-scoped entry to `result.runId`
      // (`requireEntriesToBelongToRun`), so pinning `result.runId` to the
      // request pins the entries transitively. Two checks over one fact would
      // be a second source of truth for it.
      return [];
    }
    return [
      {
        code: "custom",
        path: ["runId"],
        message:
          `response runId ${JSON.stringify(result.runId)} does not match the expanded run ` +
          `${JSON.stringify(request.runId)}: the reply is a self-consistent expansion of a ` +
          "different run, and its entries were validated against the run it names rather than " +
          "the run that was asked for",
      },
    ];
  },
};

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
  const enforceRequestCorrelation = TIMELINE_REQUEST_CORRELATION_CHECKS[registration.method];
  // The correlating handler. It is what gets registered, so the check runs on
  // the caller's own request BEFORE the registry sees the value — the only
  // place both are in scope at once.
  const correlatedHandler: Handler<
    TimelineMethodRequest<MethodName>,
    TimelineMethodResponse<MethodName>
  > = async (request, context) => {
    const result = await registration.handler(request, context);
    const violations = enforceRequestCorrelation(request, result);
    if (violations.length > 0) {
      throw new RegistryDispatchError(
        "invalid_result",
        `${descriptor.method}: handler returned a result that does not correlate with the ` +
          "request (the daemon assembled a well-formed answer that does not answer the " +
          "question asked; the client is not at fault)",
        violations,
      );
    }
    return result;
  };
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
    correlatedHandler as Handler<unknown, unknown>,
    { mutating: descriptor.mutating },
  );
}

/**
 * Raised when a subscription producer emits a row belonging to a session other
 * than the one the subscribe request named.
 *
 * WHY THIS IS NOT A `RegistryDispatchError`. The query-side scope refusal has
 * a wire envelope to land in — the reply has not been sent yet. This one does
 * not: the init ack settled the moment the subscription was accepted, and an
 * emission arrives on a `$/subscription/notify` frame that carries no error
 * channel at all. So the failure takes the barrier's posture for a bad
 * emission instead — cancel the subscription, log a prefixed tripwire, stop —
 * which is the same treatment a row that fails `TimelineRowSchema` already
 * gets, and for the same reason: the value is a daemon-side defect, the wire
 * client is innocent, and the transport's other subscriptions must keep
 * working. It is thrown from inside the producer the barrier drives precisely
 * so that posture applies without restating it here.
 */
export class TimelineSubscriptionScopeError extends Error {
  readonly emittedSessionId: string;
  readonly subscribedSessionId: string;

  constructor(emittedSessionId: string, subscribedSessionId: string) {
    super(
      `emitted row sessionId ${JSON.stringify(emittedSessionId)} does not match the subscribed ` +
        `session ${JSON.stringify(subscribedSessionId)}: forwarding it would mix another ` +
        "session's history into this client's live view under a subscription id it trusts",
    );
    this.name = "TimelineSubscriptionScopeError";
    this.emittedSessionId = emittedSessionId;
    this.subscribedSessionId = subscribedSessionId;
  }
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
 * SCOPE IS THIS BINDER'S TOO. Every emitted row must name the session the
 * subscribe request named. `TimelineRowSchema` cannot enforce that — it never
 * sees the request — so a projection that accidentally attached to the wrong
 * session emits structurally valid rows that pass validation and then travel
 * under a subscription id the client trusts, mixing another session's history
 * into its live view with nothing anywhere reporting a fault. The gate sits
 * below the barrier so a cross-session row is refused with the same
 * cancel-log-stop posture a schema-invalid row gets; see
 * {@link TimelineSubscriptionScopeError} for why it cannot be a wire error.
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
    // The scope gate sits BELOW the barrier rather than beside it: the barrier
    // drives this producer, so a cross-session row throws from inside the
    // barrier's own try/catch and takes the identical cancel-log-stop posture a
    // schema-invalid row takes. Placing the check above the barrier instead
    // would let the throw escape into whichever turn the upstream event source
    // runs on — an unhandled rejection on the live path, and a check-phase
    // throw on the replay flush.
    const scopedProducer: AckBarrierProducer<TimelineRow> = {
      subscriptionId: producer.subscriptionId,
      next(row: TimelineRow): void {
        // SHAPE FIRST, SCOPE SECOND, for the same reason the query-side check
        // gives: a value carrying no `sessionId` string is not a `TimelineRow`
        // at all, and the descriptor's emission schema inside `producer.next`
        // is what says so — with the offending path and the real reason.
        // Comparing `undefined` against the subscribed session here would
        // report every malformed emission as a scope violation and bury the
        // schema failure that actually explains it.
        if (typeof row?.sessionId === "string" && row.sessionId !== request.sessionId) {
          throw new TimelineSubscriptionScopeError(row.sessionId, request.sessionId);
        }
        producer.next(row);
      },
      cancel(): void {
        producer.cancel();
      },
    };
    const barrier = createSubscriptionAckBarrier(scopedProducer, descriptor.method);
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
