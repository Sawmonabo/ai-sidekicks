// Registers a handler against its method's descriptor, so the method name, schemas and
// version-gate flag all come from the contract and a handler cannot be bound to another method's
// shapes: a query or mutation answered with one result, or a subscription answered with its
// acknowledgement before its stream.
import type {
  AnyMethodDescriptor,
  MethodRequestOf,
  MethodResponseOf,
} from "@ai-sidekicks/contracts/method-descriptor";
import type { Handler, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";

/** A descriptor answered with one result. */
type SingleResultDescriptor = AnyMethodDescriptor & {
  readonly procedureType: "query" | "mutation";
};

/** A descriptor whose handler answers the acknowledgement and then streams. */
type SubscriptionDescriptor = AnyMethodDescriptor & {
  readonly procedureType: "subscription";
};

/**
 * Binds `handler` to `descriptor`'s method, schemas and `mutating` flag on `registry`. Its
 * request and response types are inferred from the descriptor.
 */
export function registerDescribedMethod<Descriptor extends SingleResultDescriptor>(
  registry: MethodRegistry,
  descriptor: Descriptor,
  handler: Handler<MethodRequestOf<Descriptor>, MethodResponseOf<Descriptor>>,
): void {
  registerAgainstDescriptor(registry, descriptor, handler);
}

/**
 * Binds `subscribe` to a subscription descriptor's method, schemas and `mutating` flag on
 * `registry`; it resolves with the acknowledgement, and the stream it opens follows. Its request
 * and acknowledgement types are inferred from the descriptor.
 */
export function registerDescribedSubscription<Descriptor extends SubscriptionDescriptor>(
  registry: MethodRegistry,
  descriptor: Descriptor,
  subscribe: Handler<MethodRequestOf<Descriptor>, MethodResponseOf<Descriptor>>,
): void {
  registerAgainstDescriptor(registry, descriptor, subscribe);
}

function registerAgainstDescriptor<Descriptor extends AnyMethodDescriptor>(
  registry: MethodRegistry,
  descriptor: Descriptor,
  handler: Handler<MethodRequestOf<Descriptor>, MethodResponseOf<Descriptor>>,
): void {
  registry.register(
    descriptor.method,
    descriptor.requestSchema,
    descriptor.responseSchema,
    handler as Handler<unknown, unknown>,
    { mutating: descriptor.mutating },
  );
}
