// The leaf of the session-event contracts: the envelope-version brand, the shared per-field
// length cap and the canonical `CapabilityDetails` snapshot. `event.ts` re-exports all of it.
//
// This module must never import `./event.js`, directly or through what it imports. Every schema
// here is an eager module-scope initializer, and a cycle among those throws at import time.
import { z } from "zod";

import {
  DRIVER_CAPABILITY_FLAGS,
  DRIVER_TOOL_DESCRIPTION_MAX_LEN,
  DRIVER_TOOL_NAME_MAX_LEN,
  IdempotencyClassSchema,
  type DriverCapabilityFlag,
  type NormalizedProviderToolMetadata,
} from "./provider-driver.js";
import { wireFreeFormString } from "./session.js";

/**
 * The `"MAJOR.MINOR"` shape of an {@link EventEnvelopeVersion}. It rejects leading zeros
 * ("01.0", "1.01") and single-segment or three-segment forms ("1", "1.0.0").
 */
export const EVENT_ENVELOPE_VERSION_PATTERN: RegExp = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The longest {@link EventEnvelopeVersion}, checked before the pattern. It bounds parse cost:
 * `compareEventEnvelopeVersion` parses segments with `BigInt`, which is super-linear in digit
 * count, so a regex-valid segment of unbounded digits would drive unbounded work.
 */
export const EVENT_ENVELOPE_VERSION_MAX_LEN = 64;

/** A producer-set `"MAJOR.MINOR"` protocol version; see {@link EventEnvelopeVersionSchema}. */
export type EventEnvelopeVersion = string & {
  readonly __brand: "EventEnvelopeVersion";
};
/**
 * Parses an {@link EventEnvelopeVersion}, checking length and format only. An out-of-range
 * version is refused at the protocol handshake with `version.floor_exceeded` or
 * `version.ceiling_exceeded`, never here. Its ordering, `compareEventEnvelopeVersion`, lives in
 * `event.ts`: it is a pure function, so it closes no cycle.
 */
export const EventEnvelopeVersionSchema: z.ZodType<EventEnvelopeVersion> = z
  .string()
  .max(EVENT_ENVELOPE_VERSION_MAX_LEN, {
    message: `EventEnvelopeVersion must be at most ${EVENT_ENVELOPE_VERSION_MAX_LEN} characters.`,
  })
  .regex(EVENT_ENVELOPE_VERSION_PATTERN, {
    message: 'EventEnvelopeVersion must be a "MAJOR.MINOR" semver string.',
  })
  .brand<"EventEnvelopeVersion">() as unknown as z.ZodType<EventEnvelopeVersion>;

/**
 * The cap on the envelope's free-form strings (id, actor, correlation and causation ids): a
 * UUID is 36 characters, and 256 leaves headroom for composite ids without inviting abuse.
 * Raising it changes the contract.
 */
export const EVENT_FIELD_MAX_LEN = 256;

// Parse output is identical to accepted input: no `.default()`, no `.transform()`, no
// unknown-key stripping (`.strict()` at both levels).

/**
 * The longest `contractVersion`, a free-form provider-declared value bounded at the wire.
 * Distinct from {@link EVENT_ENVELOPE_VERSION_MAX_LEN}, which caps the strict protocol version.
 */
export const CAPABILITY_CONTRACT_VERSION_MAX_LEN = 64;

// Mirrors `NormalizedProviderToolMetadata` exactly. It is not `ProviderToolMetadataSchema`,
// the ingress normalizer, which default-fills `idempotency_class` and strips unknown keys, so
// parse output would diverge from accepted input. Only the normalized shape crosses the
// persistence boundary; an un-normalized tool in a snapshot is a producer bug that must fail.
const capabilityToolMetadataSchema = z
  .object({
    name: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "CapabilityDetails.tools.name"),
    idempotency_class: IdempotencyClassSchema,
    description: wireFreeFormString(
      DRIVER_TOOL_DESCRIPTION_MAX_LEN,
      "CapabilityDetails.tools.description",
    ).optional(),
  })
  .strict();

// Compile-time pins on the tool schema, so it cannot drift from the interface: its output is a
// `NormalizedProviderToolMetadata`, that shape is an acceptable input, and the schema's input
// demands no less (no `.default()` or laxer optionality). Assignability cannot see `.strict()`'s
// unknown-key rejection; the event test suite covers that at runtime.
type _AssertExtends<A extends B, B> = A;
type _ToolSchemaOutputIsNormalized = _AssertExtends<
  z.output<typeof capabilityToolMetadataSchema>,
  NormalizedProviderToolMetadata
>;
type _NormalizedIsToolSchemaInput = _AssertExtends<
  NormalizedProviderToolMetadata,
  z.input<typeof capabilityToolMetadataSchema>
>;
type _ToolSchemaInputIsNormalized = _AssertExtends<
  z.input<typeof capabilityToolMetadataSchema>,
  NormalizedProviderToolMetadata
>;

/**
 * The canonical capability snapshot of one driver: its flags, contract version and normalized
 * tools. `tools` carries the normalized shape, which the ingress `ProviderToolMetadata` is not.
 */
export interface CapabilityDetails {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string;
  tools: readonly NormalizedProviderToolMetadata[];
}
// The exported schema's annotation replaces its inferred type, so the pins below bind this
// unannotated twin and the export aliases it.
const capabilityDetailsObjectSchema = z
  .object({
    // An enum-keyed record has exhaustive keys in Zod 4: every flag must be present and
    // boolean, so a capability is explicit, never inferred from absence.
    flags: z.record(z.enum(DRIVER_CAPABILITY_FLAGS), z.boolean()),
    contractVersion: wireFreeFormString(
      CAPABILITY_CONTRACT_VERSION_MAX_LEN,
      "CapabilityDetails.contractVersion",
    ),
    tools: z.array(capabilityToolMetadataSchema),
  })
  .strict();
/** Parses a {@link CapabilityDetails}; every capability flag is required. */
export const CapabilityDetailsSchema: z.ZodType<CapabilityDetails> = capabilityDetailsObjectSchema;

// Compile-time pins on the outer object: the `z.ZodType<CapabilityDetails>` annotation does not
// catch a grown required field. The schema's output satisfies `CapabilityDetails`; every
// `CapabilityDetails` is an acceptable input (with `tools` rebuilt from the interface's readonly
// array, since Zod types array inputs as mutable); and `tools` stays required.
type _CapabilityDetailsOutputIsCanonical = _AssertExtends<
  z.output<typeof capabilityDetailsObjectSchema>,
  CapabilityDetails
>;
type _CanonicalIsCapabilityDetailsInput = _AssertExtends<
  CapabilityDetails,
  Omit<z.input<typeof capabilityDetailsObjectSchema>, "tools"> & {
    tools: CapabilityDetails["tools"];
  }
>;
type _CapabilityDetailsInputKeepsRequiredTools = _AssertExtends<
  z.input<typeof capabilityDetailsObjectSchema>["tools"],
  readonly NormalizedProviderToolMetadata[]
>;
