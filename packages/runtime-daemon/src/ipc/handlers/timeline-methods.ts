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

import type {
  Handler,
  MethodRegistry,
  TimelineMethodBinding,
  TimelineMethodName,
} from "@ai-sidekicks/contracts";

/**
 * Bind one `timeline.*` method onto the supplied registry from its canonical
 * descriptor.
 *
 * @param registry - the daemon's method registry (`MethodRegistryImpl`).
 * @param descriptor - a member of `TIMELINE_METHOD_DESCRIPTORS`. Supplies the
 *   method string, both schemas, and the `mutating` flag; the handler's types
 *   are inferred from it.
 * @param handler - the async handler. It is GUARANTEED a request that already
 *   passed `descriptor.requestSchema` (I-007-7), and its resolved value is
 *   validated against `descriptor.responseSchema` before it reaches the wire.
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
 * `Spec-007 §Fallback Behavior`'s read-only-continues rule. The flag is taken
 * from the descriptor rather than passed in, so a caller cannot raise it.
 */
export function registerTimelineMethod<
  MethodName extends TimelineMethodName,
  RequestType,
  ResponseType,
>(
  registry: MethodRegistry,
  descriptor: TimelineMethodBinding<MethodName, RequestType, ResponseType>,
  handler: Handler<RequestType, ResponseType>,
): void {
  registry.register(
    descriptor.method,
    descriptor.requestSchema,
    descriptor.responseSchema,
    handler,
    { mutating: descriptor.mutating },
  );
}
