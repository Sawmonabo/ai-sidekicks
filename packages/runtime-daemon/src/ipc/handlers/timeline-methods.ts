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

import { TIMELINE_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts";
import type {
  Handler,
  MethodRegistry,
  TimelineMethodName,
  TimelineMethodRequest,
  TimelineMethodResponse,
} from "@ai-sidekicks/contracts";

/**
 * What a caller supplies to bind one `timeline.*` method: the NAME, and a
 * handler whose types follow from it.
 *
 * There is deliberately no schema slot. The schemas are not an input.
 */
export interface TimelineMethodRegistration<MethodName extends TimelineMethodName> {
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
 */
export function registerTimelineMethod<MethodName extends TimelineMethodName>(
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
