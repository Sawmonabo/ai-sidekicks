// Registers a query or mutation handler against its method's descriptor, so the
// method name, its schemas and its version-gate flag all come from the one
// contract that states them and a handler can never be bound to another
// method's shapes.
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
