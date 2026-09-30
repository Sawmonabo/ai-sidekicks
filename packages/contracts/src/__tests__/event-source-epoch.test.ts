// The `sourceEpoch` / `sourcePosition` payload stamp and `withEpochStamp`, which adds it to a
// run-scoped payload schema.
//   - Both scalars accept 0 and positive integers only; 0 is the epoch before any rollback, a
//     value and never a falsy sentinel. Their payload key names are pinned by exact string.
//   - `withEpochStamp` keeps strictness, keeps the stamp optional (absence means current
//     epoch), and its pairing refinement rejects an epoch without a position, a position
//     without an epoch, and the pair without a present, non-null `runId`. Pairing cases assert
//     the issue path so a base-parse failure cannot mask a missing refinement.
//   - The generic constraint refuses a payload that already declares either stamp key, so a
//     double wrap cannot compile; two `@ts-expect-error` directives pin it (an unused one is
//     TS2578). Strictness is inherited, not imposed, so the ratchet also refuses a wrapped
//     branch whose payload is not strict.
//   - Stand-in union branches use a simplified envelope: six of `buildCommonShape`'s eight
//     members, with loosened scalars. They prove payload behavior inside a discriminated-union
//     branch, not envelope fidelity, which session-event.test.ts covers. Each branch's
//     `category` is asserted against `SESSION_EVENT_CATEGORY_BY_TYPE`, not derived from it.
//   - The wrap-admission ratchet walks the live `SessionEventSchema` union: a branch carries the
//     stamp exactly when its payload carries `runId` and its category admits it, and no other
//     branch carries the keys. A strict payload that skipped the wrap would reject a stamped
//     row wherever the strict layer parses it; the tolerant `EventEnvelopeSchema` accepts it
//     either way. A known-bad synthetic union is fed through the same classifier so each
//     violation class is shown to fire, including a `run_lifecycle` branch (stragglers are
//     absorbed, never appended) and `usage.rate_limit_update` (no `runId`, so a stamp is
//     unattributable). A payload may itself be a discriminated union (`session.notice`), so the
//     walk resolves arms and applies each rule per arm.
//   - The pair rides inside `payload`; a top-level `sourceEpoch` is still refused by
//     `EventEnvelopeSchema`.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  EventEnvelopeSchema,
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

describe("SourceEpochSchema / SourcePositionSchema (scalar shapes)", () => {
  it.each([
    // 0 is a real value on both scales.
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

describe("payload-field + stub-projection key names (pins)", () => {
  it.each([
    ["SOURCE_EPOCH_PAYLOAD_KEY", SOURCE_EPOCH_PAYLOAD_KEY, "sourceEpoch"],
    ["SOURCE_POSITION_PAYLOAD_KEY", SOURCE_POSITION_PAYLOAD_KEY, "sourcePosition"],
  ])("%s === %s", (_label, actual, expected) => {
    // Exact-string pins: the stamping code and the compactor's stub projection write and read
    // these literals.
    expect(actual).toBe(expected);
  });

  it("the composed schema's keys ARE the pinned consts (no drift)", () => {
    // Parses a payload written with the literal names, so the pins are not inert strings next
    // to a schema that used different keys.
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

// A run-scoped payload with a required `runId`, as every real run-scoped variant carries.
const runScopedPayloadSchema = z
  .object({
    runId: z.string().min(1),
    text: z.string(),
  })
  .strict();

// `runId` optional, so the "pair without runId" case passes the base parse and only the
// refinement's runId leg can reject it.
const optionalRunIdPayloadSchema = z
  .object({
    runId: z.string().min(1).optional(),
    text: z.string(),
  })
  .strict();

// The account-plane shape with no `runId` key, like `usage.rate_limit_update`: even a
// mistaken wrap cannot produce a stamped row for it.
const accountPlanePayloadSchema = z
  .object({
    limitName: z.string(),
    resetsAt: z.string(),
  })
  .strict();

// `runId` nullable: the other spelling of "no run", which a key-presence check would wave
// through. `null` is what a nullable column or unresolved run handle produces.
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

// Issue paths are asserted, not just `success: false`, so a pairing failure cannot be confused
// with a base-schema rejection.
const issuePaths = (result: z.ZodSafeParseResult<unknown>): string[] =>
  result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));

// Compile-time pin, checked by `tsc -p tsconfig.test.json`: the stamp keys land as optional
// numbers beside the base payload's fields. A widening of the helper's return type fails there.
const compileTimeStamped: {
  runId: string;
  text: string;
  sourceEpoch?: number | undefined;
  sourcePosition?: number | undefined;
} = stampedRunScoped.parse({ runId: RUN_ID, text: "hi" });
void compileTimeStamped;

// Compile-time pins on the generic constraint that keeps the stamp pair declared only inside
// `withEpochStamp`. Each directive covers one error; if its construct stops failing, TS
// reports the directive unused (TS2578). The function is never invoked: a body is typechecked
// anyway, and running pin B would throw out of Zod's `util.extend` on a colliding base, which
// is dependency behavior this suite should not assert on.
const epochStampConstraintPins = (): void => {
  // Pin A: a base payload that hand-rolls `sourceEpoch` is refused at the wrap site; without
  // the constraint the caller's declaration would be silently overridden.
  const collidingBasePayloadSchema = z
    .object({ runId: z.string().min(1), sourceEpoch: z.number() })
    .strict();
  // @ts-expect-error — Shape already declares `sourceEpoch`.
  void withEpochStamp(collidingBasePayloadSchema);

  // Pin B: double-wrapping is the same collision, since the inner output already carries both
  // stamp keys.
  // @ts-expect-error — the inner wrap's Shape already declares both stamp keys.
  void withEpochStamp(withEpochStamp(runScopedPayloadSchema));
};
void epochStampConstraintPins;

// A stripping payload: a bare `z.object()` accepts an unknown key and drops it from the
// output (unlike a loose object, which passes it through). The helper's parameter is annotated
// `ZodObject<Shape, $strict>`, but Zod's object-config type parameters are structurally
// interchangeable, so the annotation documents the precondition without enforcing it.
// Composition inherits strictness; the admission ratchet below is what refuses a wrapped
// branch whose payload is not strict.
const strippingPayloadSchema = z.object({ runId: z.string().min(1), text: z.string() });

describe("withEpochStamp (composition helper)", () => {
  it("preserves the base payload's own field validation", () => {
    // Composition adds keys; it must not relax the payload's own validation.
    expect(stampedRunScoped.safeParse({ runId: RUN_ID }).success).toBe(false);
    expect(stampedRunScoped.safeParse({ runId: "", text: "hi" }).success).toBe(false);
  });

  it("preserves strictness — the composed payload still rejects unknown keys", () => {
    // Composition must not open unknown-key acceptance, or a composed payload would absorb
    // keys that the canonical bytes then hash.
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
    // Composing a stripping payload yields a stripping payload: the helper neither tightens
    // nor rescues a caller's schema. The admission ratchet refuses a wrapped non-strict branch.
    const stampedStripping = withEpochStamp(strippingPayloadSchema);
    // The unknown key is accepted and then dropped, so parse output diverges from input. On a
    // real branch that is the bug: the canonical bytes are hashed from the emitted row, and a
    // stripped key makes the stored payload un-reproducible.
    const parsed = stampedStripping.parse({ runId: RUN_ID, text: "hi", smuggled: "x" });
    expect(parsed).toStrictEqual({ runId: RUN_ID, text: "hi" });
    // The pairing refinement still applies to the non-strict composition.
    expect(stampedStripping.safeParse({ runId: RUN_ID, text: "hi", sourceEpoch: 1 }).success).toBe(
      false,
    );
  });

  it("accepts an UNSTAMPED payload — absence is the current-epoch signal", () => {
    // A required stamp would force producers to fabricate an attribution.
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
    // The pair sits in the RFC 8785 canonical bytes, so a serialization that altered it would
    // break the hash chain.
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
    // Not reachable over JSON, but in-process a spread of `number | undefined` sources plants
    // both keys unconditionally, and Zod 4 preserves them. A key-presence test would pass a
    // half-stamped row, which is why the refinement reads `!== undefined`.
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
    // The base parse succeeds here, so only the refinement's runId leg can reject.
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
    // A run-less payload is illegal only when it carries a stamp.
    expect(stampedOptionalRunId.safeParse({ text: "hi" }).success).toBe(true);
  });

  it("rejects the pair with an EXPLICITLY NULL runId — null is 'no run'", () => {
    // The key is present, so a key-presence check would admit this row; `null` names no run
    // just as absence does, so the refinement tests the value.
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
    // Control for the row above: a null runId matters to the refinement only when a stamp
    // rides along.
    const parsed = stampedNullableRunId.parse({ runId: null, text: "hi" });
    expect(parsed).toStrictEqual({ runId: null, text: "hi" });
  });

  it("rejects a stamp on a payload with NO runId key — the account-plane control", () => {
    // `usage.rate_limit_update` is account-plane with no run identity, so it never takes the
    // stamp.
    const result = stampedAccountPlane.safeParse({
      limitName: "requests_per_minute",
      resetsAt: "2026-07-24T00:00:00.000Z",
      sourceEpoch: 1,
      sourcePosition: 2,
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("runId");
    // Unstamped account-plane rows stay valid.
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

// Stand-in branches reproduce the real construction (literal `type` and `category`, a
// `withEpochStamp` payload, `.strict()`, `z.discriminatedUnion("type", …)`) so a stamped row
// parses and a half-stamped one is rejected from inside a union branch. The envelope is
// simplified: `standInCommonShape` carries six of `buildCommonShape`'s eight members
// (no `correlationId` or `causationId`) with plain `z.string().min(1)` scalars.

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

// One representative member of each of the four late-append families.
const STAND_IN_MEMBERS: readonly (readonly [SessionEventType, EventCategory])[] = [
  ["assistant.message", "assistant_output"],
  ["tool.invoked", "tool_activity"],
  ["usage.token_count", "usage_telemetry"],
  ["artifact.published", "artifact_publication"],
];

const standInUnion = z.discriminatedUnion("type", [
  buildStandInBranch("assistant.message", "assistant_output"),
  buildStandInBranch("tool.invoked", "tool_activity"),
  buildStandInBranch("usage.token_count", "usage_telemetry"),
  buildStandInBranch("artifact.published", "artifact_publication"),
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
      // Ties each stand-in to `SESSION_EVENT_CATEGORY_BY_TYPE`, so a branch cannot pair a type
      // with a category the registry rejects.
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

// The four categories whose every run-scoped variant admits the stamp.
const STAMP_ADMITTING_CATEGORIES: readonly EventCategory[] = [
  "assistant_output",
  "tool_activity",
  "usage_telemetry",
  "artifact_publication",
];

// The payload key that marks a variant run-scoped.
const RUN_ID_PAYLOAD_KEY = "runId";

type BranchFacts = {
  readonly type: string;
  readonly category: string;
  readonly runScoped: boolean;
  readonly stampKeyCount: number;
  readonly refined: boolean;
  readonly payloadStrict: boolean;
};

// Structural view of the union internals the walk reads. The exported schemas are annotated
// `z.ZodType<T>` for `isolatedDeclarations`, which erases the ZodObject surface, so the walk
// re-widens it (as session-event.test.ts does for `EventCategorySchema.options`).
type LiteralView = { readonly def: { readonly values: readonly string[] } };
type PayloadObjectView = {
  readonly shape: Readonly<Record<string, unknown>>;
  readonly def: {
    readonly checks?: readonly unknown[];
    readonly catchall?: { readonly def: { readonly type: string } } | undefined;
  };
};
type PayloadUnionView = { readonly options: readonly PayloadView[] };
type PayloadView = PayloadObjectView | PayloadUnionView;
type BranchView = {
  readonly shape: {
    readonly type: LiteralView;
    readonly category: LiteralView;
    readonly payload: PayloadView;
  };
};
type UnionView = { readonly options: readonly BranchView[] };

// A branch payload is one object schema or a discriminated union of them, and an option may
// itself be a union (`session.notice` discriminates on `kind`, then `settings_ignored` on
// `provider`). Flattening to arms keeps every rule below arm-exact.
const payloadArms = (payload: PayloadView): readonly PayloadObjectView[] => {
  if (Array.isArray((payload as PayloadUnionView).options)) {
    return (payload as PayloadUnionView).options.flatMap(payloadArms);
  }
  if ((payload as PayloadObjectView).shape !== undefined) {
    return [payload as PayloadObjectView];
  }
  throw new Error(
    "readBranchFacts: a branch payload is neither a ZodObject (`.shape`) nor a union of them (`.options`) — the walk cannot read its facts, and reading none would make every admission rule vacuous.",
  );
};

const readBranchFacts = (union: unknown): BranchFacts[] =>
  (union as UnionView).options.map((branch) => {
    const arms = payloadArms(branch.shape.payload);
    // Stamp keys aggregate with `some` (any stamped arm makes the branch stamped), pinned by the
    // second-arm known-bad row below; run-scopedness, refinement and strictness need every arm
    // to qualify, so a compliant sibling cannot hide a bad arm.
    const stampKeys = [SOURCE_EPOCH_PAYLOAD_KEY, SOURCE_POSITION_PAYLOAD_KEY].filter((key) =>
      arms.some((arm) => Object.hasOwn(arm.shape, key)),
    );
    return {
      type: branch.shape.type.def.values[0] ?? "(no discriminator literal)",
      category: branch.shape.category.def.values[0] ?? "(no category literal)",
      runScoped: arms.every((arm) => Object.hasOwn(arm.shape, RUN_ID_PAYLOAD_KEY)),
      stampKeyCount: stampKeys.length,
      // Hand-rolled stamp keys without the pairing refinement are not a wrap: they would admit
      // half-stamped rows. Any check counts, since Zod does not label refinement provenance, so
      // hand-rolled keys plus an unrelated `.refine()` still read as wrapped.
      refined: arms.every((arm) => (arm.def.checks ?? []).length > 0),
      // A strict object carries a `never` catchall; a loose or stripping one carries `unknown`
      // or none. A wrapped non-strict payload would strip unknown keys.
      payloadStrict: arms.every((arm) => arm.def.catchall?.def.type === "never"),
    };
  });

const admissionViolations = (branches: readonly BranchFacts[]): string[] => {
  const violations: string[] = [];
  for (const branch of branches) {
    const mustAdmit =
      STAMP_ADMITTING_CATEGORIES.includes(branch.category as EventCategory) && branch.runScoped;
    if (mustAdmit && !(branch.stampKeyCount === 2 && branch.refined)) {
      violations.push(
        `${branch.type}: run-scoped ${branch.category} branch MUST be wrapped with withEpochStamp (found ${branch.stampKeyCount}/2 stamp keys, refinement ${branch.refined ? "present" : "absent"}) — a strict payload would reject a stamped row wherever SessionEventSchema parses it, while the tolerant EventEnvelopeSchema carrier accepts it either way`,
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
    // A broken introspection read would yield zero branches and every rule below would pass
    // vacuously.
    expect(liveBranches.map((branch) => branch.type).sort()).toEqual(
      [...SESSION_EVENT_TYPES].sort(),
    );
  });

  it("every registered branch satisfies the wrap-admission rule", () => {
    expect(admissionViolations(liveBranches)).toEqual([]);
  });

  it("run_lifecycle is excluded from stamp admission (family pin + live-branch walk)", () => {
    // A lifecycle straggler is absorbed by the run engine, never late-appended, so the stamp
    // has no meaning there.
    expect(STAMP_ADMITTING_CATEGORIES).not.toContain("run_lifecycle");

    // The same fact against the live union; the synthetic run_lifecycle control below proves the
    // must-not-admit rule fires.
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
      "run-scoped tool_activity branch whose payload UNION has one stamped arm",
      z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("tool.invoked"),
            category: z.literal("tool_activity"),
            // A discriminated-union payload, like `session.notice`; a known-bad case keeps the
            // union path of the walk from staying green when broken.
            payload: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("plain"), runId: z.string().min(1) }).strict(),
              z
                .object({
                  kind: z.literal("stamped"),
                  runId: z.string().min(1),
                  sourceEpoch: SourceEpochSchema.optional(),
                  sourcePosition: SourcePositionSchema.optional(),
                })
                .strict(),
            ]),
          })
          .strict(),
      ]),
      "MUST be wrapped",
    ],
    [
      "account-plane usage_telemetry branch whose payload UNION stamps only its SECOND arm",
      z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("usage.rate_limit_update"),
            category: z.literal("usage_telemetry"),
            // Aggregation-direction control: the branch is not run-scoped and the stamp is on the
            // trailing arm, so this fires only because stamp keys aggregate with `some`. The
            // union row above cannot tell the readings apart.
            payload: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("plain"), limitName: z.string() }).strict(),
              z
                .object({
                  kind: z.literal("stamped"),
                  limitName: z.string(),
                  sourceEpoch: SourceEpochSchema.optional(),
                  sourcePosition: SourcePositionSchema.optional(),
                })
                .strict(),
            ]),
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
    // Negative control for the zero-violation result above: each union is built like the real
    // one and carries one deliberate defect.
    const violations = admissionViolations(readBranchFacts(badUnion));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(expectedFragment);
  });

  it("the ratchet PASSES a correctly wrapped run-scoped branch", () => {
    // The rule is satisfiable, so the failures above come from the defects.
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

  it.each([[SOURCE_EPOCH_PAYLOAD_KEY], [SOURCE_POSITION_PAYLOAD_KEY]])(
    "rejects `%s` as a TOP-LEVEL envelope member (membership is closed)",
    (key) => {
      const broken = { ...buildEnvelope(), [key]: 1 };
      expect(EventEnvelopeSchema.safeParse(broken).success).toBe(false);
    },
  );
});
