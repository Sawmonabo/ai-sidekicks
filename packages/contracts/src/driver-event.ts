// DriverEvent — the driver-runtime slice of the Plan-006 event census, in a
// downstream leaf module so Plan-005 can author its own derived view without
// editing the taxonomy file that supplies it (Plan-005 T4.4).
//
// `driver.subscribeEvents` streams one run's driver activity, and `DriverEvent`
// is the name for what may travel on it. The CATEGORY LIST is ratified by
// `Plan-005 §Phase 4 — Client SDK exposure + degraded-fallback` decision #4 —
// seven categories that ALREADY EXIST in the Plan-006 census, no new one. So
// what this file adds is a derived VIEW over Plan-006-owned categories, not a
// taxonomy edit: `event.ts` names the categories and the per-category arrays,
// and everything below is mechanical off them.
//
// OWNERSHIP — the categories are Plan-006's; these four derived symbols are
// Plan-005 contract surface, which is why they live here rather than beside the
// arrays. Plan-005's consumption edge on `event.ts` is already registered
// (`docs/architecture/cross-plan-dependencies.md` §3, the Plan-006 entry on the
// Plan-005 row), and reading exports across that edge is what this file does;
// authoring these symbols INTO `event.ts` would instead have been a Plan-005
// edit to a file it does not own.
//
// The derivation is authored ONCE here and consumed on both sides of the wire:
// the daemon handler filters against the set before buffering, the SDK
// validates every delivered value against the schema. The set previously lived
// module-locally in the daemon handler, which left the SDK seam with no
// narrower schema to reach for — a mismatched daemon could push an approval or
// membership row onto a driver-event subscription and every layer would accept
// it (Codex review, PR #396).
//
// WHY A SEPARATE MODULE RATHER THAN A BLOCK IN `provider-driver.ts` — the
// eager cycle it avoids. `provider-driver.ts` is Plan-005's domain file and is
// the natural home by ownership, but it is the one file in this package that
// cannot hold these symbols:
//
//     provider-driver.ts → event.ts → event-core.ts → provider-driver.ts
//
//   * `provider-driver.ts` → `event.ts` — the VALUE imports this file needs
//     (the seven per-category arrays and `SessionEventSchema`), each read at
//     module scope by the set and schema initializers below.
//   * `event.ts` → `event-core.ts` — the hoisted-cluster re-export seam.
//   * `event-core.ts` → `provider-driver.ts` — VALUE imports
//     (`DRIVER_CAPABILITY_FLAGS`, `IdempotencyClassSchema`, and the two
//     tool-metadata caps), read at module scope by `CapabilityDetailsSchema`.
//
// That last edge is why `provider-driver.ts` already DUPLICATES
// `DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN` rather than importing its twin from
// `event-core.ts`; the reasoning is recorded on that constant and applies here
// unchanged. Every edge is an eager module-scope initializer, so no evaluation
// order satisfies all three. TypeScript compiles module cycles silently and
// the failure appears only at runtime, as a partially-evaluated namespace
// yielding `undefined` where a schema expects a value.
//
// This module is downstream-only — nothing in the taxonomy chain imports it —
// so it can never participate in that cycle. Consumers import from
// `@ai-sidekicks/contracts`; no wire contract moves.
//
// TWO NAMES, TWO JOBS. Read them by job rather than by analogy to
// `SessionEventType` / `SESSION_EVENT_TYPES`, whose const/type polarity is the
// reverse of this pair's:
//   • `DRIVER_EVENT_TYPES` is the CENSUS-level runtime domain — every
//     event-type string the seven categories carry. This is the daemon
//     filter's membership test. It must judge a census type that has no
//     payload variant yet exactly as it will once one lands, because the
//     filter's job is deciding what BELONGS on the stream, not what parses.
//   • `DriverEvent` / `DriverEventType` are the PARSED-value discriminant —
//     the arms `SessionEvent` actually registers inside those categories. That
//     is a strict subset of the set above and stays one, because payload
//     variants reach `SessionEventSchema` one at a time as their emitting plan
//     ships them (the census note above `SESSION_EVENT_TYPES` records why).
//     A reader who expects a `run.*` case here and finds none is seeing that
//     subset relation, not a gap: `run_lifecycle` is the first category
//     decision #4 names and no `run.*` payload variant is registered yet.
// The two agree by construction — set membership by type, union membership by
// category — and __tests__/driver-event.test.ts asserts that bridge directly
// over every registered type. That assertion is what `DriverEventSchema`'s
// type assertion below rests on.

import { z } from "zod";

import {
  ARTIFACT_PUBLICATION_EVENT_TYPES,
  ASSISTANT_OUTPUT_EVENT_TYPES,
  INTERACTIVE_REQUEST_EVENT_TYPES,
  RUNTIME_NODE_LIFECYCLE_EVENT_TYPES,
  RUN_LIFECYCLE_EVENT_TYPES,
  SessionEventSchema,
  TOOL_ACTIVITY_EVENT_TYPES,
  USAGE_TELEMETRY_EVENT_TYPES,
  type SessionEvent,
  type SessionEventType,
} from "./event.js";

// The seven `EventCategory` values a driver event may carry. Hand-written
// because the list is a DESIGN choice over the 20-category census that nothing
// derives; everything from here down is mechanical off it and off the
// per-category arrays. Module-local: the exported surface is the set, the two
// types, and the schema — a consumer narrowing by category narrows through
// `DriverEvent` itself. `runtime_node_lifecycle` is on the list for
// `runtime_node.capability_declared` / `runtime_node.capability_updated`
// (CP-005-5), not for node administration.
type DriverEventCategory =
  | "run_lifecycle"
  | "assistant_output"
  | "tool_activity"
  | "interactive_request"
  | "artifact_publication"
  | "usage_telemetry"
  | "runtime_node_lifecycle";

/**
 * Every `SessionEventType` in the seven driver-event categories — the runtime
 * membership test a driver-event stream filters on.
 *
 * Spread from the per-category arrays rather than hand-listed, for the reason
 * every derived set here is derived: a category that grows a new event type
 * joins this set automatically, where a hand-written list would silently start
 * dropping a driver event and look correct while doing it.
 */
export const DRIVER_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set<SessionEventType>([
  ...RUN_LIFECYCLE_EVENT_TYPES,
  ...ASSISTANT_OUTPUT_EVENT_TYPES,
  ...TOOL_ACTIVITY_EVENT_TYPES,
  ...INTERACTIVE_REQUEST_EVENT_TYPES,
  ...ARTIFACT_PUBLICATION_EVENT_TYPES,
  ...USAGE_TELEMETRY_EVENT_TYPES,
  ...RUNTIME_NODE_LIFECYCLE_EVENT_TYPES,
]);

/**
 * The `SessionEvent` arms a `driver.subscribeEvents` stream may deliver.
 *
 * Derived by `Extract` over the union's own literal `category` member, NOT over
 * the per-category arrays: those are annotated `readonly SessionEventType[]`
 * (the `--isolatedDeclarations` widening noted on them in `event.ts`), so their
 * element type is the whole `SessionEventType` census and `[number]` would
 * derive nothing.
 * Every variant interface carries its category as a literal, so the union is
 * the one surface that still knows which arm belongs to which category — which
 * makes this derivation exact and keeps the event types out of any hand-list.
 */
export type DriverEvent = Extract<SessionEvent, { category: DriverEventCategory }>;

/** The `type` discriminant of `DriverEvent`. Derived, never hand-listed. */
export type DriverEventType = DriverEvent["type"];

/**
 * `SessionEventSchema` narrowed to the driver-event categories.
 *
 * Accepts exactly the values `SessionEventSchema` accepts whose `type` is in
 * `DRIVER_EVENT_TYPES`, and REFUSES every other session event — so a consumer
 * validating with this schema cannot be handed a membership, approval, or
 * audit row by a daemon that filtered wrongly or not at all.
 *
 * `.superRefine()` rather than `.transform()` or a rebuilt union: the taxonomy's
 * schemas are non-normalizing by contract (parsed output must be byte-identical
 * to input for the canonical-bytes path), and rebuilding a seven-category
 * discriminated union here would be a second registration of arms
 * `SessionEventSchema` already owns. `.superRefine()` returns `this` and Zod
 * clones internally, so `SessionEventSchema` itself is unchanged — the census
 * test asserts it still accepts a non-driver event after this schema is built,
 * because a mutation there would silently narrow every consumer of the full
 * union.
 *
 * The cast is justified by the bridge the census test asserts: within the
 * registered arms, `DRIVER_EVENT_TYPES` membership and `DriverEventCategory`
 * membership are the same predicate, so a value that passes the runtime check
 * is a `DriverEvent`. The explicit annotation is what keeps the export
 * `--isolatedDeclarations`-clean.
 */
export const DriverEventSchema: z.ZodType<DriverEvent> = SessionEventSchema.superRefine(
  (event, ctx) => {
    if (DRIVER_EVENT_TYPES.has(event.type)) return;
    ctx.addIssue({
      code: "custom",
      path: ["type"],
      message: `Event type '${event.type}' is outside the driver event categories and cannot travel on a driver event stream.`,
    });
  },
) as z.ZodType<DriverEvent>;
