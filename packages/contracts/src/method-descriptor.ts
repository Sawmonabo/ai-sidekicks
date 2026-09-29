// One daemon method's wire contract, stated once: its name, its procedure type,
// whether it changes state, and the schemas the registry validates its request,
// its result and (for a subscription) each emission against.
//
// Every namespace declares its methods as a table of descriptors keyed by method
// name, and the daemon's method map is composed from those tables, so a method's
// name and its shapes live in one place. A descriptor registers nothing: a method
// reaches the wire only when the daemon service that answers it registers a
// handler against its descriptor.
import type { ZodType, output } from "zod";

/**
 * How a method answers. A `query` reads and a `mutation` changes state, each with
 * one result; a `subscription` answers with an acknowledgement and then streams
 * emissions.
 */
export type MethodProcedureType = "query" | "mutation" | "subscription";

/**
 * A `query` or `mutation` method's contract.
 *
 * `mutating` is what the daemon's version gate reads: while a client's protocol
 * version is incompatible, a mutating method is refused and a read passes.
 */
export interface MethodDescriptor<MethodName extends string, RequestType, ResponseType> {
  readonly method: MethodName;
  readonly procedureType: MethodProcedureType;
  readonly mutating: boolean;
  readonly requestSchema: ZodType<RequestType>;
  /** What the handler's resolved value is validated against. */
  readonly responseSchema: ZodType<ResponseType>;
}

/**
 * A subscription's contract: the acknowledgement the handler resolves with is
 * `responseSchema`, and every value pushed afterwards is `emissionSchema`. The
 * two answer different questions, so a subscription carries both.
 */
export interface SubscriptionMethodDescriptor<
  MethodName extends string,
  RequestType,
  ResponseType,
  EmissionType,
> extends MethodDescriptor<MethodName, RequestType, ResponseType> {
  readonly procedureType: "subscription";
  readonly emissionSchema: ZodType<EmissionType>;
}

/**
 * The shape every entry of a descriptor table satisfies, whatever its request and
 * response types.
 */
export interface AnyMethodDescriptor {
  readonly method: string;
  readonly procedureType: MethodProcedureType;
  readonly mutating: boolean;
  readonly requestSchema: ZodType;
  readonly responseSchema: ZodType;
  readonly emissionSchema?: ZodType;
}

/**
 * A namespace's descriptors keyed by method name, each entry naming the key it
 * sits under, so a descriptor can never be filed under another method's name.
 */
export type MethodDescriptorTable<Table> = {
  readonly [MethodName in keyof Table]: AnyMethodDescriptor & { readonly method: MethodName };
};

/**
 * Freezes a namespace's descriptor table and each descriptor in it. Frozen
 * because it is a registry: code that could re-point a schema at start-up could
 * change what the daemon accepts on a method without touching that method's own
 * module.
 */
export function defineMethodDescriptors<const Table extends MethodDescriptorTable<Table>>(
  table: Table,
): Table {
  for (const descriptor of Object.values<AnyMethodDescriptor>(table)) {
    Object.freeze(descriptor);
  }
  return Object.freeze(table);
}

/** The request type a descriptor's request schema parses to. */
export type MethodRequestOf<Descriptor extends AnyMethodDescriptor> = output<
  Descriptor["requestSchema"]
>;

/** The result type a descriptor's response schema parses to. */
export type MethodResponseOf<Descriptor extends AnyMethodDescriptor> = output<
  Descriptor["responseSchema"]
>;

/** The per-emission type of a subscription descriptor. */
export type MethodEmissionOf<Descriptor extends AnyMethodDescriptor> =
  Descriptor["emissionSchema"] extends ZodType ? output<Descriptor["emissionSchema"]> : never;
