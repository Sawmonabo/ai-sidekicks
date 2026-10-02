// One daemon method's wire contract: its name, procedure type, whether it changes state, and the
// schemas its request, result and emissions are validated against. A descriptor registers nothing;
// a method reaches the wire only when a daemon service registers a handler for it.
import { z, type ZodType, type output } from "zod";

/** A request or reply that carries nothing: the method's whole effect is what it changed. */
export type EmptyPayload = Record<string, never>;
/** Parses an {@link EmptyPayload}; any member is refused. */
export const EmptyPayloadSchema: z.ZodType<EmptyPayload, EmptyPayload> = z.object({}).strict();

/**
 * How a method answers. A `query` reads and a `mutation` changes state, each with
 * one result; a `subscription` answers with an acknowledgement and then streams
 * emissions.
 */
export type MethodProcedureType = "query" | "mutation" | "subscription";

/**
 * What every method's contract states, whatever its procedure type.
 *
 * `mutating` is what the daemon's version gate reads: while a client's protocol
 * version is incompatible, a mutating method is refused and a read passes.
 */
interface MethodContract<MethodName extends string, RequestType, ResponseType> {
  readonly method: MethodName;
  readonly procedureType: MethodProcedureType;
  readonly mutating: boolean;
  readonly requestSchema: ZodType<RequestType>;
  /** What the handler's resolved value is validated against. */
  readonly responseSchema: ZodType<ResponseType>;
}

/** A `query` or `mutation` method's contract: it answers with one result. */
export interface MethodDescriptor<
  MethodName extends string,
  RequestType,
  ResponseType,
> extends MethodContract<MethodName, RequestType, ResponseType> {
  readonly procedureType: "query" | "mutation";
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
> extends MethodContract<MethodName, RequestType, ResponseType> {
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
 * Freezes a namespace's descriptor table and each descriptor in it, so no code can re-point a
 * method's schema at start-up without touching that method's own module.
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
