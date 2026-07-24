// Plan-006 T1.9 — cross-cutting `sourceEpoch` + `sourcePosition`
// epoch-attribution carrier suite (the CP-004-12 registration).
//
// Backstops Spec-006 §Event Type Enumeration (the cross-cutting payload-field
// pair) and Spec-006 §Compacted Event Format (the audit-stub `originPosition`
// projection key). This file owns the TYPED SHAPE only: stamping is Plan-004
// T3.11's and consumption is the T3.14 supersede projection's, so no
// assertion here speaks to when a row gets stamped. Coverage shape:
//   • SourceEpochSchema / SourcePositionSchema accept 0 and positive
//     integers and reject negatives, non-integers, and non-numbers — `0` is
//     the pre-any-rollback epoch, so it is a VALUE, never a falsy sentinel.
//   • The three shared wire literals are pinned by exact string equality:
//     `sourceEpoch` / `sourcePosition` (the registered payload-field names
//     two plans' code writes and reads) and `originPosition` (the audit-stub
//     projection key the Plan-004 T3.12 rewind-span check reads back). A
//     rename is forbidden-non-additive per `ADR-018 §Decision` #8.
//   • withEpochStamp composition: strictness survives (a composed strict
//     payload still rejects unknown keys), the stamp stays OPTIONAL (absence
//     means current-epoch), and the pairing refinement rejects all three
//     partial shapes — epoch without position, position without epoch, and
//     the pair without a present, non-null `runId`. Each pairing case asserts
//     the ISSUE PATH, not just `success === false`: a required-key failure in
//     the base object parse would otherwise mask a missing refinement. Both
//     "no run" spellings are covered (absent AND explicitly null), as is the
//     key-present-value-undefined half stamp the in-process producer path can
//     emit but JSON cannot.
//   • The ONE compile-enforced admission rule: the generic constraint refuses
//     a payload shape that already declares either stamp key, so the
//     cross-cutting pair is declared in withEpochStamp and nowhere else, and
//     a double-wrap cannot compile. Pinned by two `@ts-expect-error`
//     directives that self-verify — if either construct stops failing, TS
//     reports the directive unused (TS2578) and the tsconfig.test.json leg
//     goes red. Everything else about admission is a RUNTIME rule: notably
//     strictness is INHERITED, not imposed (Zod's object-config type
//     parameters are structurally interchangeable, so the helper's `$strict`
//     parameter annotation documents the precondition rather than enforcing
//     it — a `@ts-expect-error` there would be reported unused), which is why
//     the ratchet below also refuses a wrapped branch whose payload is not
//     strict.
//   • End-to-end validation of a fully-stamped event of each run-scoped
//     family, through a discriminated union assembled the way
//     `SessionEventSchema` is. These branches are STAND-INS, deliberately:
//     no payload branch of the five late-append families is registered in
//     the live union yet (see the admission ratchet below), and authoring
//     them is each emitting plan's job, not T1.9's. They are also a
//     DELIBERATE SIMPLIFICATION — six of `buildCommonShape`'s eight members
//     (no `correlationId` / `causationId`), with loosened scalar types —
//     because envelope-field validation is session-event.test.ts's lane.
//     What the stand-ins prove is payload-slot behavior INSIDE a
//     `discriminatedUnion` branch, not envelope fidelity. Each one's
//     `category` is PINNED AGAINST SESSION_EVENT_CATEGORY_BY_TYPE by
//     assertion rather than derived from it, so the drift protection is the
//     assertion: a type/category pair that disagrees with the census turns
//     that pin red instead of silently re-deriving to match.
//   • The WRAP-ADMISSION RATCHET over the LIVE `SessionEventSchema` union:
//     a branch is required to carry the stamp exactly when it is run-scoped
//     (its payload carries `runId`) AND belongs to an admitting family; any
//     other branch must not carry the keys at all. Today every registered
//     branch is in the must-not class and passes non-vacuously; the ratchet
//     turns red when a run-scoped branch of an admitting family lands
//     unwrapped — a strict payload schema that skipped the wrap would reject
//     a stamped row at subscription or replay validation. Because a
//     zero-violation result is only trustworthy if the checker can fail, a
//     known-bad synthetic union is fed through the same classifier and each
//     violation class is asserted to fire, including the two negative
//     controls the plan names by hand: a `run_lifecycle` branch (stragglers
//     are absorbed, never appended) and the account-plane
//     `usage.rate_limit_update` (no `runId` — an epoch stamp there is
//     unattributable).
//   • The envelope canonical set is UNTOUCHED (I-006-1-03): the pair rides
//     inside `payload`, and a top-level `sourceEpoch` member is still
//     rejected by EventEnvelopeSchema's closed membership.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  EventEnvelopeSchema,
  ORIGIN_POSITION_STUB_KEY,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SESSION_EVENT_TYPES,
  SessionEventSchema,
  SOURCE_EPOCH_PAYLOAD_KEY,
  SourceEpochSchema,
  SOURCE_POSITION_PAYLOAD_KEY,
  SourcePositionSchema,
  withEpochStamp,
  type EventCategory,
  type SessionEventType,
} from "../event.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const RUN_ID = "990e8400-e29b-41d4-a716-446655440004";
const VERSION = "1.0";

// --------------------------------------------------------------------------
// Scalar shapes.
// --------------------------------------------------------------------------

describe("SourceEpochSchema / SourcePositionSchema (T1.9 scalar shapes)", () => {
  it.each([
    // `0` is the pre-any-rollback epoch and the first turn boundary — a
    // real value on both scales, so it must parse.
    ["zero (the pre-any-rollback epoch / first position)", 0, true],
    ["one", 1, true],
    ["a large integer", 4096, true],
    ["negative", -1, false],
    ["negative zero-adjacent", -0.5, false],
    ["fractional", 1.5, false],
    ["NaN", Number.NaN, false],
    ["Infinity", Number.POSITIVE_INFINITY, false],
    ["numeric string", "0", false],
    ["boolean", true, false],
    ["null", null, false],
    ["undefined", undefined, false],
    ["bigint", 1n, false],
  ])("SourceEpochSchema: %s -> %s", (_label, candidate, shouldPass) => {
    expect(SourceEpochSchema.safeParse(candidate).success).toBe(shouldPass);
  });

  it.each([
    ["zero (the pre-any-rollback epoch / first position)", 0, true],
    ["one", 1, true],
    ["a large integer", 4096, true],
    ["negative", -1, false],
    ["negative zero-adjacent", -0.5, false],
    ["fractional", 1.5, false],
    ["NaN", Number.NaN, false],
    ["Infinity", Number.POSITIVE_INFINITY, false],
    ["numeric string", "0", false],
    ["boolean", true, false],
    ["null", null, false],
    ["undefined", undefined, false],
    ["bigint", 1n, false],
  ])("SourcePositionSchema: %s -> %s", (_label, candidate, shouldPass) => {
    expect(SourcePositionSchema.safeParse(candidate).success).toBe(shouldPass);
  });
});

// --------------------------------------------------------------------------
// The three pinned wire literals.
// --------------------------------------------------------------------------

describe("payload-field + stub-projection key names (T1.9 pins)", () => {
  it.each([
    ["SOURCE_EPOCH_PAYLOAD_KEY", SOURCE_EPOCH_PAYLOAD_KEY, "sourceEpoch"],
    ["SOURCE_POSITION_PAYLOAD_KEY", SOURCE_POSITION_PAYLOAD_KEY, "sourcePosition"],
    ["ORIGIN_POSITION_STUB_KEY", ORIGIN_POSITION_STUB_KEY, "originPosition"],
  ])("%s === %s", (_label, actual, expected) => {
    // Exact-string pins, not shape checks: Plan-004's stamping leg
    // (T3.11/T3.14) and the Plan-006 T3.2 compactor's stub projection write
    // and read these literals across plan boundaries, and a rename is
    // forbidden-non-additive per `ADR-018 §Decision` #8.
    expect(actual).toBe(expected);
  });

  it("the composed schema's keys ARE the pinned consts (no drift)", () => {
    // The helper keys its `.extend()` off the consts, so this parses a
    // payload written with the LITERAL names and confirms both survive —
    // the pins above would otherwise be inert strings next to a schema that
    // used different keys.
    const composed = withEpochStamp(z.object({ runId: z.string() }).strict());
    const parsed = composed.parse({
      runId: RUN_ID,
      sourceEpoch: 2,
      sourcePosition: 7,
    });
    expect(parsed[SOURCE_EPOCH_PAYLOAD_KEY]).toBe(2);
    expect(parsed[SOURCE_POSITION_PAYLOAD_KEY]).toBe(7);
  });
});

// --------------------------------------------------------------------------
// withEpochStamp composition + pairing refinement.
// --------------------------------------------------------------------------

// A representative run-scoped payload: `runId` REQUIRED, as every real
// run-scoped family variant carries it.
const runScopedPayloadSchema = z
  .object({
    runId: z.string().min(1),
    text: z.string(),
  })
  .strict();

// The same payload with `runId` OPTIONAL. Load-bearing for the
// "pair without runId" case: with a REQUIRED runId the input dies in the
// base object parse, so the assertion would pass whether or not the
// refinement's runId leg exists at all. Optional runId lets the base parse
// succeed, leaving the refinement as the only thing that can reject.
const optionalRunIdPayloadSchema = z
  .object({
    runId: z.string().min(1).optional(),
    text: z.string(),
  })
  .strict();

// The account-plane shape: NO `runId` key at all — the
// `usage.rate_limit_update` case (Spec-006 §Usage Telemetry). It is never
// admitted to the stamp; this schema exists to prove that even a mistaken
// wrap cannot produce a stamped account-plane row.
const accountPlanePayloadSchema = z
  .object({
    limitName: z.string(),
    resetsAt: z.string(),
  })
  .strict();

// `runId` NULLABLE — the OTHER spelling of "no run", and the one a
// key-presence check would wave through: the key is present, its value just
// names no run. Load-bearing because `null` is what a nullable column or an
// unresolved run handle actually produces at the producer boundary, so it is
// a reachable input, not a theoretical one.
const nullableRunIdPayloadSchema = z
  .object({
    runId: z.string().min(1).nullable(),
    text: z.string(),
  })
  .strict();

const stampedRunScoped = withEpochStamp(runScopedPayloadSchema);
const stampedOptionalRunId = withEpochStamp(optionalRunIdPayloadSchema);
const stampedAccountPlane = withEpochStamp(accountPlanePayloadSchema);
const stampedNullableRunId = withEpochStamp(nullableRunIdPayloadSchema);

// Issue paths are asserted (not just `success: false`) so a pairing failure
// cannot be confused with an unrelated base-schema rejection.
const issuePaths = (result: z.ZodSafeParseResult<unknown>): string[] =>
  result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));

// COMPILE-TIME pin on the composed output type, validated by the
// `tsconfig.test.json` typecheck leg: the stamp keys land as OPTIONAL numbers
// alongside the base payload's own fields — the public surface a wrapping
// registrant programs against. An annotation-only assignment, so a widening
// of the helper's return type fails the leg rather than this suite.
const compileTimeStamped: {
  runId: string;
  text: string;
  sourceEpoch?: number | undefined;
  sourcePosition?: number | undefined;
} = stampedRunScoped.parse({ runId: RUN_ID, text: "hi" });
void compileTimeStamped;

// COMPILE-TIME pins on the generic constraint, validated by the same leg.
// `Shape extends … & { sourceEpoch?: never; sourcePosition?: never }` is the
// ONE wrap-admission rule the compiler enforces: the cross-cutting pair is
// declared inside withEpochStamp and nowhere else. Each directive below is
// typed to cover exactly one error, and is self-verifying — if the construct
// it guards ever stops failing, TS reports the directive itself as unused
// (TS2578) and this leg goes red rather than silently losing the pin.

// Held in a function that is NEVER INVOKED. A function body is typechecked
// regardless of whether it is called, so the pins do their whole job at
// compile time — and must not run: `@ts-expect-error` suppresses the type
// error but leaves the call, and executing pin B would trip the runtime
// residual documented on withEpochStamp's return cast (a colliding base
// carrying a refinement throws out of Zod's `util.extend`). That throw is a
// dependency's behavior, not this contract's, and asserting on it here would
// pin a message string we do not own.
const epochStampConstraintPins = (): void => {
  // Pin A — a base payload that hand-rolls `sourceEpoch` is refused AT THE
  // WRAP SITE. Without the constraint this compiles and the caller's own
  // declaration is silently overridden by the canonical stamp schema.
  const collidingBasePayloadSchema = z
    .object({ runId: z.string().min(1), sourceEpoch: z.number() })
    .strict();
  // @ts-expect-error — Shape already declares `sourceEpoch`.
  void withEpochStamp(collidingBasePayloadSchema);

  // Pin B — double-wrapping is the same collision by another route: the
  // inner composition's output shape already carries both stamp keys, so the
  // outer call violates the constraint.
  // @ts-expect-error — the inner wrap's Shape already declares both stamp keys.
  void withEpochStamp(withEpochStamp(runScopedPayloadSchema));
};
void epochStampConstraintPins;

// A STRIPPING payload, for the inherited-strictness pins below. A bare
// `z.object()` is `$strip` — it accepts an unknown key and DROPS it from the
// output — not `$loose`, which would pass it through; the distinction is the
// one the ratchet's catchall read below turns on, so the fixture is named for
// what it actually is. The helper's parameter is annotated
// `ZodObject<Shape, $strict>`, but Zod's object-config type parameters are
// structurally interchangeable, so that annotation DOCUMENTS the precondition
// rather than enforcing it — a `@ts-expect-error` pin here would be reported
// unused (TS2578). Composition therefore INHERITS strictness rather than
// imposing it, and the enforcement that bites lives in the admission ratchet
// below: a wrapped branch whose payload is not strict is a violation there,
// where the contract is actually breached.
const strippingPayloadSchema = z.object({ runId: z.string().min(1), text: z.string() });

describe("withEpochStamp (T1.9 composition helper)", () => {
  it("preserves the base payload's own field validation", () => {
    // Composition adds keys; it must not relax what the payload already
    // demanded.
    expect(stampedRunScoped.safeParse({ runId: RUN_ID }).success).toBe(false);
    expect(stampedRunScoped.safeParse({ runId: "", text: "hi" }).success).toBe(false);
  });

  it("preserves strictness — the composed payload still rejects unknown keys", () => {
    // The five families' payload schemas are `.strict()`; composition must
    // not open unknown-key acceptance, or a composed payload would silently
    // absorb keys the canonical bytes then hash (the I-006-1-03 no-collapse
    // stance).
    const result = stampedRunScoped.safeParse({
      runId: RUN_ID,
      text: "hi",
      sourceEpoch: 1,
      sourcePosition: 2,
      smuggled: "nope",
    });
    expect(result.success).toBe(false);
  });

  it("INHERITS strictness rather than imposing it (the honest limit)", () => {
    // Composing a stripping payload yields a stripping composed payload — the
    // helper never silently tightens a caller's schema, and equally never
    // rescues a caller who wrapped a non-strict one. Pinned so the limitation
    // is a known, tested property rather than a surprise at the first wrap;
    // the admission ratchet below is what refuses a wrapped-but-non-strict
    // branch.
    const stampedStripping = withEpochStamp(strippingPayloadSchema);
    // THE HAZARD, CONCRETELY: the unknown key is ACCEPTED (no throw) and then
    // DROPPED, so parse output diverges from parse input. On a real branch
    // that divergence is the bug — the canonical bytes are hashed from the
    // row that was emitted, and a silently-stripped key makes the stored
    // payload un-reproducible. Exactly what ratchet rule 3 exists to surface.
    const parsed = stampedStripping.parse({ runId: RUN_ID, text: "hi", smuggled: "x" });
    expect(parsed).toStrictEqual({ runId: RUN_ID, text: "hi" });
    // The pairing refinement still applies to the non-strict composition.
    expect(stampedStripping.safeParse({ runId: RUN_ID, text: "hi", sourceEpoch: 1 }).success).toBe(
      false,
    );
  });

  it("accepts an UNSTAMPED payload — absence is the current-epoch signal", () => {
    // A required stamp would force producers to fabricate an attribution;
    // absence must stay legal and must mean current-epoch.
    const parsed = stampedRunScoped.parse({ runId: RUN_ID, text: "hi" });
    expect(parsed).toStrictEqual({ runId: RUN_ID, text: "hi" });
  });

  it("accepts a FULLY stamped payload (epoch + position + runId)", () => {
    const parsed = stampedRunScoped.parse({
      runId: RUN_ID,
      text: "hi",
      sourceEpoch: 0,
      sourcePosition: 4,
    });
    expect(parsed).toStrictEqual({
      runId: RUN_ID,
      text: "hi",
      sourceEpoch: 0,
      sourcePosition: 4,
    });
  });

  it("round-trips a stamped payload through JSON unchanged", () => {
    // Same JSON-stability stance as the SessionEventSchema round-trip suite:
    // the pair sits in the RFC 8785 canonical bytes, so a serialization that
    // altered it would break the hash chain.
    const stamped = { runId: RUN_ID, text: "hi", sourceEpoch: 3, sourcePosition: 9 };
    const firstPass = stampedRunScoped.parse(stamped);
    const secondPass = stampedRunScoped.parse(JSON.parse(JSON.stringify(firstPass)) as unknown);
    expect(secondPass).toStrictEqual(firstPass);
  });

  it("rejects sourceEpoch WITHOUT sourcePosition (pairing refinement)", () => {
    const result = stampedRunScoped.safeParse({
      runId: RUN_ID,
      text: "hi",
      sourceEpoch: 1,
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain(SOURCE_POSITION_PAYLOAD_KEY);
  });

  it("rejects sourcePosition WITHOUT sourceEpoch (pairing refinement)", () => {
    const result = stampedRunScoped.safeParse({
      runId: RUN_ID,
      text: "hi",
      sourcePosition: 1,
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain(SOURCE_EPOCH_PAYLOAD_KEY);
  });

  it("rejects a stamp key set to an EXPLICIT undefined (key present, value absent)", () => {
    // Not reachable over the JSON wire — `{"sourceEpoch": undefined}` is not
    // JSON — but very reachable in-process: Plan-004 T3.11's natural spread
    // `{...base, sourceEpoch: maybeEpoch, sourcePosition: maybePosition}`
    // over `number | undefined` sources plants both keys unconditionally.
    // Zod 4's object parser PRESERVES such keys in its output, so a
    // key-presence test would see a complete pair and pass the row through
    // half-stamped. This is why the refinement reads `!== undefined`.
    const missingEpoch = stampedRunScoped.safeParse({
      runId: RUN_ID,
      text: "hi",
      sourceEpoch: undefined,
      sourcePosition: 5,
    });
    expect(missingEpoch.success).toBe(false);
    expect(issuePaths(missingEpoch)).toContain(SOURCE_EPOCH_PAYLOAD_KEY);

    const missingPosition = stampedRunScoped.safeParse({
      runId: RUN_ID,
      text: "hi",
      sourceEpoch: 5,
      sourcePosition: undefined,
    });
    expect(missingPosition.success).toBe(false);
    expect(issuePaths(missingPosition)).toContain(SOURCE_POSITION_PAYLOAD_KEY);
  });

  it("rejects the PAIR without runId — the stamp is unattributable", () => {
    // Optional-runId fixture on purpose: the base parse SUCCEEDS here, so
    // the rejection can only come from the refinement's runId leg.
    expect(optionalRunIdPayloadSchema.safeParse({ text: "hi" }).success).toBe(true);
    const result = stampedOptionalRunId.safeParse({
      text: "hi",
      sourceEpoch: 1,
      sourcePosition: 2,
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("runId");
  });

  it("accepts an unstamped payload with no runId (the refinement only gates stamps)", () => {
    // Guard against an over-broad refinement: a run-less payload is only
    // illegal when it carries a stamp.
    expect(stampedOptionalRunId.safeParse({ text: "hi" }).success).toBe(true);
  });

  it("rejects the pair with an EXPLICITLY NULL runId — null is 'no run'", () => {
    // The key is PRESENT here, so a key-presence check would admit this row
    // and persist an un-rankable stamp. `null` names no run just as squarely
    // as absence does, which is why the refinement tests the VALUE.
    const result = stampedNullableRunId.safeParse({
      runId: null,
      text: "hi",
      sourceEpoch: 1,
      sourcePosition: 2,
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("runId");
  });

  it("accepts an UNSTAMPED payload with a null runId — the base schema's lane", () => {
    // Symmetric control for the row above. A null runId is only the pairing
    // refinement's business when a stamp rides along; whether a run-less row
    // is legal at all is the payload schema's own decision, and this one
    // allows it. Without this, widening the runId guard could quietly start
    // rejecting legal unstamped rows.
    const parsed = stampedNullableRunId.parse({ runId: null, text: "hi" });
    expect(parsed).toStrictEqual({ runId: null, text: "hi" });
  });

  it("rejects a stamp on a payload with NO runId key — the account-plane control", () => {
    // `usage.rate_limit_update` (Spec-006 §Usage Telemetry) is account-plane
    // and carries no run identity, so it is never admitted to the stamp. Even
    // a mistaken wrap cannot yield a stamped account-plane row: the pair has
    // no `runId` to travel with.
    const result = stampedAccountPlane.safeParse({
      limitName: "requests_per_minute",
      resetsAt: "2026-07-24T00:00:00.000Z",
      sourceEpoch: 1,
      sourcePosition: 2,
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("runId");
    // Unstamped account-plane rows stay valid — the wrap changes nothing for
    // the shape it should never have been applied to.
    expect(
      stampedAccountPlane.safeParse({
        limitName: "requests_per_minute",
        resetsAt: "2026-07-24T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["negative epoch", { sourceEpoch: -1, sourcePosition: 0 }],
    ["fractional epoch", { sourceEpoch: 1.5, sourcePosition: 0 }],
    ["negative position", { sourceEpoch: 0, sourcePosition: -1 }],
    ["fractional position", { sourceEpoch: 0, sourcePosition: 0.5 }],
    ["string epoch", { sourceEpoch: "1", sourcePosition: 0 }],
  ])("delegates stamp-value validation to the scalar schemas: %s", (_label, stamp) => {
    const result = stampedRunScoped.safeParse({ runId: RUN_ID, text: "hi", ...stamp });
    expect(result.success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// End-to-end: a fully-stamped event of each run-scoped family.
// --------------------------------------------------------------------------
//
// STAND-INS. None of the five late-append families has a payload branch in
// the live `SessionEventSchema` union yet (each is owned by its emitting
// plan and arrives through the union-registration seam), so these branches
// reproduce the real construction where it matters for this suite: literal
// `type`/`category` + a `withEpochStamp(...)` payload, all `.strict()`,
// dispatched by `z.discriminatedUnion("type", …)`, with `type`/`category`
// pinned against the census.
//
// The envelope half is DELIBERATELY SIMPLIFIED and must not be read as a
// model of the real one: `standInCommonShape` carries six of
// `buildCommonShape`'s eight members (no `correlationId` / `causationId`)
// with loosened scalar types — plain `z.string().min(1)` where the real
// shape uses branded IDs and bounded wire-string helpers. Envelope-field
// validation belongs to session-event.test.ts; duplicating it here would
// buy a second, weaker copy of that suite. What THESE prove is that the
// composed payload survives the construction: a stamped row parses, and a
// half-stamped one is rejected from inside a union branch, not just from a
// bare payload parse.

const standInCommonShape = () => ({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime({ offset: true }),
  actor: z.string().min(1).nullable().optional(),
  version: z.string(),
});

const buildStandInBranch = <T extends SessionEventType, C extends EventCategory>(
  eventType: T,
  category: C,
) =>
  z
    .object({
      ...standInCommonShape(),
      type: z.literal(eventType),
      category: z.literal(category),
      payload: withEpochStamp(runScopedPayloadSchema),
    })
    .strict();

// The five late-append families, one representative member each — plus BOTH
// members of the `interactive_request` closed pair, which is the only part of
// that 15-member category the late-append window covers.
const STAND_IN_MEMBERS: readonly (readonly [SessionEventType, EventCategory])[] = [
  ["assistant.message", "assistant_output"],
  ["tool.invoked", "tool_activity"],
  ["usage.token_count", "usage_telemetry"],
  ["artifact.published", "artifact_publication"],
  ["driver_ask.requested", "interactive_request"],
  ["driver_ask.canceled", "interactive_request"],
];

const standInUnion = z.discriminatedUnion("type", [
  buildStandInBranch("assistant.message", "assistant_output"),
  buildStandInBranch("tool.invoked", "tool_activity"),
  buildStandInBranch("usage.token_count", "usage_telemetry"),
  buildStandInBranch("artifact.published", "artifact_publication"),
  buildStandInBranch("driver_ask.requested", "interactive_request"),
  buildStandInBranch("driver_ask.canceled", "interactive_request"),
]);

const buildStandInEvent = (eventType: SessionEventType, category: EventCategory) => ({
  id: `evt-${eventType}`,
  sessionId: SESSION_ID,
  sequence: 12,
  occurredAt: "2026-07-20T19:14:35.000Z",
  category,
  type: eventType,
  actor: null,
  version: VERSION,
  payload: {
    runId: RUN_ID,
    text: "late-appended straggler",
    sourceEpoch: 1,
    sourcePosition: 5,
  },
});

describe("stamped events validate end-to-end through a union (stand-in branches)", () => {
  it.each(STAND_IN_MEMBERS)(
    "%s carries the canonical category %s per the census",
    (eventType, category) => {
      // Ties every stand-in to SESSION_EVENT_CATEGORY_BY_TYPE, so a branch
      // below cannot pair a type with a category the taxonomy rejects.
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(eventType)).toBe(category);
    },
  );

  it.each(STAND_IN_MEMBERS)(
    "a fully-stamped %s event validates end-to-end",
    (eventType, category) => {
      const parsed = standInUnion.parse(buildStandInEvent(eventType, category));
      expect(parsed.payload.sourceEpoch).toBe(1);
      expect(parsed.payload.sourcePosition).toBe(5);
    },
  );

  it.each(STAND_IN_MEMBERS)("an UNstamped %s event still validates", (eventType, category) => {
    const event = buildStandInEvent(eventType, category);
    const parsed = standInUnion.parse({
      ...event,
      payload: { runId: RUN_ID, text: "current-epoch row" },
    });
    expect(parsed.payload.sourceEpoch).toBeUndefined();
  });

  it.each(STAND_IN_MEMBERS)(
    "a HALF-stamped %s event is rejected from inside the union branch",
    (eventType, category) => {
      const event = buildStandInEvent(eventType, category);
      const result = standInUnion.safeParse({
        ...event,
        payload: { runId: RUN_ID, text: "half stamp", sourceEpoch: 1 },
      });
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain(`payload.${SOURCE_POSITION_PAYLOAD_KEY}`);
    },
  );
});

// --------------------------------------------------------------------------
// The wrap-admission ratchet over the LIVE SessionEventSchema union.
// --------------------------------------------------------------------------

// The four categories whose every run-scoped variant admits the stamp, plus
// the two `interactive_request` members that do. Admission is scoped by the
// late-append window of Spec-006 §Event Type Enumeration, NOT by category
// alone: `interactive_request` admits only the closed pair, and within the
// four categories only the run-attributed variants qualify (the account-plane
// `usage.rate_limit_update` carries no `runId` and is excluded by the
// run-scopedness leg below).
const STAMP_ADMITTING_CATEGORIES: readonly EventCategory[] = [
  "assistant_output",
  "tool_activity",
  "usage_telemetry",
  "artifact_publication",
];
const STAMP_ADMITTING_TYPES: readonly SessionEventType[] = [
  "driver_ask.requested",
  "driver_ask.canceled",
];

// The payload key that marks a variant run-scoped, per Spec-006 §Event Type
// Enumeration ("whose variant is run-scoped — the payload carries `runId`").
const RUN_ID_PAYLOAD_KEY = "runId";

type BranchFacts = {
  readonly type: string;
  readonly category: string;
  readonly runScoped: boolean;
  readonly stampKeyCount: number;
  readonly refined: boolean;
  readonly payloadStrict: boolean;
};

// Minimal structural view of the union internals this walk reads. The cast
// below is the same affordance session-event.test.ts uses to read
// `EventCategorySchema.options`: the exported schemas are annotated
// `z.ZodType<T>` for `isolatedDeclarations`, which erases the ZodObject
// surface, so branch introspection has to re-widen it. Reading structure (not
// re-declaring it) is the point — the walk must see the SHIPPED union.
type LiteralView = { readonly def: { readonly values: readonly string[] } };
type PayloadView = {
  readonly shape: Readonly<Record<string, unknown>>;
  readonly def: {
    readonly checks?: readonly unknown[];
    readonly catchall?: { readonly def: { readonly type: string } } | undefined;
  };
};
type BranchView = {
  readonly shape: {
    readonly type: LiteralView;
    readonly category: LiteralView;
    readonly payload: PayloadView;
  };
};
type UnionView = { readonly options: readonly BranchView[] };

const readBranchFacts = (union: unknown): BranchFacts[] =>
  (union as UnionView).options.map((branch) => {
    const payloadKeys = Object.keys(branch.shape.payload.shape);
    const stampKeys = [SOURCE_EPOCH_PAYLOAD_KEY, SOURCE_POSITION_PAYLOAD_KEY].filter((key) =>
      payloadKeys.includes(key),
    );
    return {
      type: branch.shape.type.def.values[0] ?? "(no discriminator literal)",
      category: branch.shape.category.def.values[0] ?? "(no category literal)",
      runScoped: payloadKeys.includes(RUN_ID_PAYLOAD_KEY),
      stampKeyCount: stampKeys.length,
      // A hand-rolled pair of keys without the pairing refinement is NOT a
      // wrap: it would admit exactly the half-stamped rows the helper exists
      // to reject. `withEpochStamp` leaves a refinement check on the payload
      // schema, so requiring one narrows that hole. Residual: a payload that
      // hand-rolls both stamp keys AND carries some unrelated `.refine()`
      // still reads as wrapped here — presence of a check is the signal, not
      // its identity, because Zod does not label refinement provenance.
      refined: (branch.shape.payload.def.checks ?? []).length > 0,
      // A strict object carries a `never` catchall; a loose or stripping one
      // carries `unknown` or none. Composition INHERITS strictness (see the
      // helper's honest-limit pin above), so a branch that wrapped a
      // non-strict payload would strip unknown keys — parse output diverging
      // from the hashed canonical bytes.
      payloadStrict: branch.shape.payload.def.catchall?.def.type === "never",
    };
  });

const admissionViolations = (branches: readonly BranchFacts[]): string[] => {
  const violations: string[] = [];
  for (const branch of branches) {
    const inAdmittingFamily =
      STAMP_ADMITTING_CATEGORIES.includes(branch.category as EventCategory) ||
      STAMP_ADMITTING_TYPES.includes(branch.type as SessionEventType);
    const mustAdmit = inAdmittingFamily && branch.runScoped;
    if (mustAdmit && !(branch.stampKeyCount === 2 && branch.refined)) {
      violations.push(
        `${branch.type}: run-scoped ${branch.category} branch MUST be wrapped with withEpochStamp (found ${branch.stampKeyCount}/2 stamp keys, refinement ${branch.refined ? "present" : "absent"}) — a strict payload would reject a stamped row at replay validation`,
      );
    }
    if (!mustAdmit && branch.stampKeyCount > 0) {
      violations.push(
        `${branch.type}: ${branch.category} branch MUST NOT admit the epoch stamp (found ${branch.stampKeyCount} stamp key(s); run-scoped: ${branch.runScoped})`,
      );
    }
    if (branch.stampKeyCount > 0 && !branch.payloadStrict) {
      violations.push(
        `${branch.type}: a stamped payload MUST stay strict — composition inherits strictness, so wrapping a non-strict payload silently strips unknown keys away from the canonical bytes`,
      );
    }
  }
  return violations;
};

describe("wrap-admission ratchet over the live SessionEventSchema union", () => {
  const liveBranches = readBranchFacts(SessionEventSchema);

  it("the branch walk sees every registered payload variant (non-vacuity guard)", () => {
    // Without this, a broken introspection read would yield zero branches and
    // every rule assertion below would pass vacuously. Both-direction set
    // equality against the registered-variant roster.
    expect(liveBranches.map((branch) => branch.type).sort()).toEqual(
      [...SESSION_EVENT_TYPES].sort(),
    );
  });

  it("every registered branch satisfies the wrap-admission rule", () => {
    expect(admissionViolations(liveBranches)).toEqual([]);
  });

  it("run_lifecycle is excluded from stamp admission (family pin + live-branch walk)", () => {
    // A lifecycle straggler is ABSORBED by the run engine, never
    // late-appended, so the stamp has no meaning there.
    //
    // LEG 1 — the DESIGN FACT, asserted against the admission table itself.
    // Non-vacuous today, and it stays green when lifecycle branches
    // legitimately register, because it pins the RULE rather than the
    // current branch roster. Both halves of the table are checked: a
    // lifecycle type could otherwise slip in through the per-type list.
    expect(STAMP_ADMITTING_CATEGORIES).not.toContain("run_lifecycle");
    for (const admittingType of STAMP_ADMITTING_TYPES) {
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(admittingType)).not.toBe("run_lifecycle");
    }

    // LEG 2 — the same fact against the live union. It walks ZERO branches
    // today (no `run_lifecycle` variant is registered yet), so it cannot
    // fail on its own; it is here to catch the first lifecycle branch that
    // lands wrapped. That the must-not-admit rule actually FIRES is proven
    // by the synthetic run_lifecycle control below, not by this leg.
    const lifecycleBranches = liveBranches.filter((branch) => branch.category === "run_lifecycle");
    for (const branch of lifecycleBranches) {
      expect(branch.stampKeyCount).toBe(0);
    }
  });

  it.each([
    [
      "run-scoped assistant_output branch left UNWRAPPED",
      z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("assistant.message"),
            category: z.literal("assistant_output"),
            payload: runScopedPayloadSchema,
          })
          .strict(),
      ]),
      "MUST be wrapped",
    ],
    [
      "run-scoped tool_activity branch with stamp KEYS but no pairing refinement",
      z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("tool.invoked"),
            category: z.literal("tool_activity"),
            payload: runScopedPayloadSchema.extend({
              sourceEpoch: SourceEpochSchema.optional(),
              sourcePosition: SourcePositionSchema.optional(),
            }),
          })
          .strict(),
      ]),
      "MUST be wrapped",
    ],
    [
      "run_lifecycle branch carrying the stamp (absorb-never-append control)",
      z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("run.completed"),
            category: z.literal("run_lifecycle"),
            payload: withEpochStamp(runScopedPayloadSchema),
          })
          .strict(),
      ]),
      "MUST NOT admit",
    ],
    [
      "account-plane usage.rate_limit_update carrying the stamp (no-run-identity control)",
      z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("usage.rate_limit_update"),
            category: z.literal("usage_telemetry"),
            payload: withEpochStamp(accountPlanePayloadSchema),
          })
          .strict(),
      ]),
      "MUST NOT admit",
    ],
    [
      "run-scoped assistant_output branch wrapped over a NON-STRICT payload",
      z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("assistant.message"),
            category: z.literal("assistant_output"),
            payload: withEpochStamp(strippingPayloadSchema),
          })
          .strict(),
      ]),
      "MUST stay strict",
    ],
  ])("the ratchet FIRES on a known-bad union: %s", (_label, badUnion, expectedFragment) => {
    // Negative control for the zero-violation result above: a checker that
    // cannot fail proves nothing. Each arm is a union built exactly like the
    // real one, carrying one deliberate defect.
    const violations = admissionViolations(readBranchFacts(badUnion));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(expectedFragment);
  });

  it("the ratchet PASSES a correctly wrapped run-scoped branch", () => {
    // The positive half of the control: the rule is satisfiable, so the
    // failures above come from the defects, not from an unsatisfiable rule.
    const goodUnion = z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("assistant.message"),
          category: z.literal("assistant_output"),
          payload: withEpochStamp(runScopedPayloadSchema),
        })
        .strict(),
    ]);
    expect(admissionViolations(readBranchFacts(goodUnion))).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// The envelope canonical set stays fixed (I-006-1-03).
// --------------------------------------------------------------------------

describe("the carrier is a PAYLOAD field, not an envelope field", () => {
  const buildEnvelope = () => ({
    id: "evt-epoch-0001",
    sessionId: SESSION_ID,
    sequence: 12,
    occurredAt: "2026-07-20T19:14:35.000Z",
    category: "assistant_output" as const,
    type: "assistant.message",
    actor: null,
    version: VERSION,
    payload: {
      runId: RUN_ID,
      sourceEpoch: 1,
      sourcePosition: 5,
    },
  });

  it("carries the pair inside `payload` through the tolerant envelope", () => {
    const parsed = EventEnvelopeSchema.parse(buildEnvelope());
    expect(parsed.payload[SOURCE_EPOCH_PAYLOAD_KEY]).toBe(1);
    expect(parsed.payload[SOURCE_POSITION_PAYLOAD_KEY]).toBe(5);
  });

  it.each([[SOURCE_EPOCH_PAYLOAD_KEY], [SOURCE_POSITION_PAYLOAD_KEY], [ORIGIN_POSITION_STUB_KEY]])(
    "rejects `%s` as a TOP-LEVEL envelope member (I-006-1-03 membership is closed)",
    (key) => {
      // The registration takes no envelope member and no version bump: the
      // canonical set stays the eleven of Spec-006 §Canonical Serialization
      // Rules. `originPosition` is likewise a stub-projection key, never an
      // envelope member.
      const broken = { ...buildEnvelope(), [key]: 1 };
      expect(EventEnvelopeSchema.safeParse(broken).success).toBe(false);
    },
  );
});
