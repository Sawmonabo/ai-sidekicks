// Event-core — the dependency LEAF of the session-event contracts: the
// envelope-version brand, the shared per-field length cap, and the canonical
// `CapabilityDetails` snapshot, in a module that imports nothing able to reach
// back into `event.ts`. `event.ts` re-exports all eight symbols — six values
// plus the `CapabilityDetails` and `EventEnvelopeVersion` types — so consumers
// keep importing them from `@ai-sidekicks/contracts`.
//
// THE LEAF INVARIANT — this module imports `zod`, `./session.js` and
// `./provider-driver.js`, and NEVER `./event.js`. That set is closed under the
// same check: `session.ts` imports only zod + `./internal/branded.js` +
// `./jsonrpc-streaming.js` (both zod-only), and `provider-driver.ts` imports
// only zod + `./session.js` — so no path out of this file reaches back into
// `event.ts`. Every schema here is an EAGER module-scope Zod initializer, and a
// module cycle among such initializers throws `ReferenceError` at import time.
//
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

// --------------------------------------------------------------------------
// EventEnvelopeVersion — branded "MAJOR.MINOR" semver string.
// --------------------------------------------------------------------------
//
//   /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/
// Rejects leading zeros on either segment ("01.0", "1.01") and pure
// numeric/single-segment forms ("1", "1.0.0").

export const EVENT_ENVELOPE_VERSION_PATTERN: RegExp = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Length ceiling for an EventEnvelopeVersion string, enforced at the parse
// boundary BEFORE the format regex. This is a bound on parse cost, not a
// format rule: `compareEventEnvelopeVersion` parses each segment with `BigInt`
// for exact ordering above `Number.MAX_SAFE_INTEGER`, and BigInt construction
// from a decimal string is super-linear in digit count — so an unbounded but
// regex-valid input (a single segment of arbitrarily many digits) would let a
// caller drive parse work without limit. Real protocol versions are
// single/low-double-digit segments so 64 characters is generous headroom for
// any plausible MAJOR.MINOR while keeping the BigInt parse trivially cheap.
// This is a strict MAJOR.MINOR protocol-version bound, deliberately distinct
// from `VERSION_STRING_MAX_LEN` (error.ts), which caps free-form version
// strings in error details — the two must not be coupled.
export const EVENT_ENVELOPE_VERSION_MAX_LEN = 64;

export type EventEnvelopeVersion = string & {
  readonly __brand: "EventEnvelopeVersion";
};
/**
 * Runtime validator for the branded {@link EventEnvelopeVersion} — the
 * producer-set `"MAJOR.MINOR"` protocol version whose bump/stub/read rules
 * live. An out-of-range version is refused at the protocol handshake (never
 * by this format-and-length-only validator), whose reply carries the
 * `version.floor_exceeded` or `version.ceiling_exceeded` reason.
 *
 * Its total ordering is `compareEventEnvelopeVersion` (event.ts), which stays
 * beside the envelope it gates rather than riding this leaf: it is a pure
 * function over the brand, so no module-scope initializer reads it and it
 * closes no cycle.
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

// --------------------------------------------------------------------------
// EVENT_FIELD_MAX_LEN — the shared cap on the envelope's free-form strings.
// --------------------------------------------------------------------------
//
// id / actor / correlationId / causationId. UUIDs are 36 chars; 256 leaves
// plenty of headroom for any composite identifier scheme without enabling DoS.
// It is one member of the defense-in-depth per-field cap set whose full
// multi-file survey — which caps exist, where each is declared, and why the
// contracts package holds a second line of defense at all — stays in event.ts,
// the module whose envelope fields consume them. Raising it is a contract bump.

export const EVENT_FIELD_MAX_LEN = 256;

// --------------------------------------------------------------------------
// CapabilityDetails — canonical capability snapshot.
// --------------------------------------------------------------------------
//
// The canonical typed shape of one driver's capability snapshot: its flags,
// its contract version, and its normalized tools. The daemon's capability
// writer compares a fresh snapshot against the cached one in this shape.
//
// NON-NORMALIZING end to end — parse output is structurally identical to
// accepted input: no `.default()`, no `.transform()`, no unknown-key
// stripping (`.strict()` at both levels) — the same no-collapse stance as the
// envelope's notes in event.ts.

// 64: generous headroom for any plausible driver-contract version string
// while bounding pathological
// input at the wire/replay trust boundary. Deliberately NOT
// `EVENT_ENVELOPE_VERSION_MAX_LEN` — that caps the strict MAJOR.MINOR
// protocol version, whereas `contractVersion` is a free-form
// provider-declared value (its semver bound lives Phase-2 write seam, not
// at this wire layer).
export const CAPABILITY_CONTRACT_VERSION_MAX_LEN = 64;

// Module-LOCAL strict tool schema — single consumer, so it fails the export
// hoist bar (2+ surfaces). Mirrors `NormalizedProviderToolMetadata`
// (provider-driver.ts) EXACTLY, including `description?: string | undefined`
// optionality under `exactOptionalPropertyTypes`. Deliberately NOT
// `ProviderToolMetadataSchema`: that schema is the INGRESS normalizer — it
// default-fills `idempotency_class` and strips unknown keys, so routing
// event payloads through it would make parse output diverge from accepted
// input. Here `idempotency_class` is REQUIRED with no `.default()`: only the
// NORMALIZED tool shape crosses the persistence boundary (provider-driver.ts),
// and an un-normalized entry in a snapshot is a producer bug that must fail
// loud, never be silently repaired.
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

// COMPILE-TIME PIN (tool element) — schema↔interface drift here would let a
// parse accept a shape the interface does not describe. The three directions
// below pin the TOOL-ELEMENT schema (the outer
// `CapabilityDetails` object has its own pin block after its schema, below):
// (1) everything the element schema emits is a
// `NormalizedProviderToolMetadata`; (2) every `NormalizedProviderToolMetadata`
// is an acceptable schema INPUT (a schema that grows a required field breaks
// this); (3) the schema repairs nothing — its input demands no less than the
// normalized shape (a `.default()`/laxer-optionality regression breaks this,
// per the no-silent-repair rule in the schema comment above). Honest residual:
// assignability cannot see `.strict()`'s unknown-key REJECTION, so a dropped
// schema field with `.strict()` retained is runtime-covered by the event.ts
// test suite, not by these pins.
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
 * Canonical capability snapshot of one driver. `tools` is `readonly` and carries
 * the NORMALIZED tool shape, which the ingress `ProviderToolMetadata` is not.
 */
export interface CapabilityDetails {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string;
  tools: readonly NormalizedProviderToolMetadata[];
}
// Unannotated module-local twin: the exported const below carries an explicit
// `z.ZodType<CapabilityDetails>` annotation (isolatedDeclarations), and that
// annotation REPLACES the inferred object type — `z.input`/`z.output` of the
// export would just echo the annotation, telling the outer-object pins
// nothing. The pins therefore bind this twin, and the export aliases it.
const capabilityDetailsObjectSchema = z
  .object({
    // Enum-keyed record = EXHAUSTIVE keys in Zod 4: every member of the live
    // `DRIVER_CAPABILITY_FLAGS` const must be present, and a missing member,
    // an unknown key, or a non-boolean value all reject — matching the
    // non-partial `Record<DriverCapabilityFlag, boolean>` type and the
    // write-seam exactly-all-flags cardinality guard (capabilities are
    // explicit, never inferred from absence). Keyed off the const — not a
    // copied literal list — so the scheduled flag widening flows through
    // with zero edits here.
    flags: z.record(z.enum(DRIVER_CAPABILITY_FLAGS), z.boolean()),
    contractVersion: wireFreeFormString(
      CAPABILITY_CONTRACT_VERSION_MAX_LEN,
      "CapabilityDetails.contractVersion",
    ),
    tools: z.array(capabilityToolMetadataSchema),
  })
  .strict();
export const CapabilityDetailsSchema: z.ZodType<CapabilityDetails> = capabilityDetailsObjectSchema;

// COMPILE-TIME PIN (outer object) — the same drift hazard as the tool-element
// pins above, one level up: the `z.ZodType<CapabilityDetails>` annotation
// does NOT catch a grown required schema field (extra properties pass
// covariant assignability), so without these pins the outer object could
// drift unnoticed.
// Directions: (1) everything the schema emits satisfies `CapabilityDetails`
// (a loosened/dropped/mistyped output field breaks this); (2) every
// `CapabilityDetails` is an acceptable schema INPUT (a grown or narrowed
// required field breaks this) — compared with `tools` rebuilt from the
// interface's own readonly array type, because Zod types array inputs as
// mutable and `readonly T[]` never structurally extends `T[]`, while
// PASSING a readonly array is semantically safe (parse copies; it never
// mutates its input); (3) the `tools` key itself stays REQUIRED with the
// pinned element type — this covers the optionality drift that direction
// (2)'s `Omit`-and-rebuild deliberately masks. Honest residual: unchanged
// from the element pins — `.strict()`'s unknown-key rejection is invisible
// to assignability and stays runtime-covered.
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
