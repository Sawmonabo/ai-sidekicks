// Registers a query or mutation handler against its method's descriptor, so the method name,
// schemas and version-gate flag all come from the contract and a handler cannot be bound to
// another method's shapes.
import type {
  AnyMethodDescriptor,
  Handler,
  MethodRegistry,
  MethodRequestOf,
  MethodResponseOf,
} from "@ai-sidekicks/contracts";

/** A descriptor answered with one result: a subscription streams and binds elsewhere. */
type SingleResultDescriptor = AnyMethodDescriptor & {
  readonly procedureType: "query" | "mutation";
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
  registry.register(
    descriptor.method,
    descriptor.requestSchema,
    descriptor.responseSchema,
    handler as Handler<unknown, unknown>,
    { mutating: descriptor.mutating },
  );
}
