// Plan-005 Phase 1 T1.5 — contract-conformance tests for the internal
// provider-driver contract (`provider-driver.ts`).
//
// Phase-1 scope is TYPE-SYSTEM CONFORMANCE + CONTRACT-VALIDATION UNITS only:
// the nominal-TypeScript surfaces are proven by COMPILATION (a fully-typed mock
// driver that must typecheck, plus `@ts-expect-error` negatives), and the three
// Zod result/ingress schemas are proven by `.parse()` / `.safeParse()` units.
// There are NO behavioral round-trips here — the daemon-side hydration seam and
// the persistence/event projections that exercise these shapes at runtime ship
// in Phase 2-3 (Plan-005 T2.x / T3.x). This file ratifies the CONTRACT, not its
// consumers.
//
// Coverage map (cite → block):
//   • AC1 (`Spec-005 §Acceptance Criteria`) — a mock fully implementing `ProviderDriver` (all 10
//     ops, correctly-typed params + returns) compiles with no session-domain
//     change. The compile is the assertion; a runtime smoke confirms the mock
//     is constructable and a method returns the expected shape.
//   • AC2 (`Spec-005 §Acceptance Criteria`) — a capability flag outside the 7-flag
//     `DriverCapabilityFlag` union is a TS error (`@ts-expect-error`, self-
//     verifying via TS2578 if the invalid flag ever became valid).
//   • I-005-5 — narrowing a `DriverResumeResult` to `status: "failed"` makes
//     `.bindingId` a type error; the `failed` variant structurally carries
//     `recoveryCondition` + `providerFailureDetail`. Silent replacement (a
//     binding alongside a failure signal) is inexpressible.
//   • I-005-3 — `ProviderToolMetadataSchema` defaults an omitted
//     `idempotency_class` to `manual_reconcile_only` at parse time, and passes
//     an explicit value through unchanged.
//   • Result-envelope schemas (the provider→daemon trust boundary) —
//     `DriverInterventionResultSchema`, `DriverResumeResultSchema`, and the
//     leaf `IdempotencyClassSchema` parse valid shapes and reject invalid ones
//     (including `.strict()` extra-key rejection on the result-envelope schemas;
//     `ProviderToolMetadataSchema`, by contrast, STRIPS unknown keys per
//     `Spec-005 §Default Behavior` forward-compat). Every untrusted free-form string these
//     schemas parse is length / non-whitespace / NUL-bounded via
//     `wireFreeFormString` — exercised per field below.
//
// Idiom: matches the sibling unit tests in this directory — typed-variable
// assignment as the compile-time proof (session-id.test.ts), `.parse()` /
// `.safeParse(...).success` for schema units (session-create.test.ts /
// session-event.test.ts), relative `../provider-driver.js` import. The package
// uses no `expectTypeOf` / `assertType` helper, so the compile-time assertions
// here are typed-binding + `@ts-expect-error`, exactly as the siblings do.
//
// Refs: `Spec-005 §Acceptance Criteria` (AC1 — driver implementable with no session-domain change),
// `Spec-005 §Acceptance Criteria` (AC2 — off-union capability flag is a type error), `Spec-005 §Fallback Behavior`
// (resume-failure surfacing), `Spec-005 §idempotency_class` (idempotency default), Plan-005
// Phase 1, I-005-3, I-005-5.
import { describe, expect, it } from "vitest";

import {
  DRIVER_BINDING_ID_MAX_LEN,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DRIVER_FALLBACK_ACTION_MAX_LEN,
  DRIVER_TOOL_DESCRIPTION_MAX_LEN,
  DRIVER_TOOL_NAME_MAX_LEN,
  DriverInterventionResultSchema,
  DriverResumeResultSchema,
  IdempotencyClassSchema,
  ProviderToolMetadataSchema,
  type ApplyInterventionParams,
  type CloseSessionParams,
  type CreateSessionParams,
  type DriverCapabilities,
  type DriverInterventionResult,
  type DriverResumeResult,
  type GetCapabilitiesResult,
  type InterruptRunParams,
  type NormalizedProviderToolMetadata,
  type ProviderDriver,
  type ProviderModel,
  type ProviderMode,
  type ProviderSessionHandle,
  type RespondToRequestParams,
  type ResumeSessionParams,
  type RunId,
  type StartRunParams,
} from "../provider-driver.js";
import { type ChannelId, type SessionId } from "../session.js";

// Real RFC 9562 UUIDs reused as branded-id runtime values (the brands are
// TS-only; the runtime is a plain UUID string). Cast at the brand boundary the
// same way the sibling fixtures feed wire strings into branded slots.
const SESSION_UUID = "550e8400-e29b-41d4-a716-446655440000";
const RUN_UUID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const CHANNEL_UUID = "880e8400-e29b-41d4-a716-446655440003";

const SESSION_ID = SESSION_UUID as SessionId;
const RUN_ID = RUN_UUID as RunId;
const CHANNEL_ID = CHANNEL_UUID as ChannelId;

// ===========================================================================
// AC1 (`Spec-005 §Acceptance Criteria`) — a mock fully implementing `ProviderDriver` compiles.
// ===========================================================================
//
// The class below implements ALL 10 operations with correctly-typed params and
// return shapes. The fact that it typechecks under `implements ProviderDriver`
// (with `exactOptionalPropertyTypes` + `isolatedDeclarations` on) IS the
// acceptance assertion: a provider integration can satisfy this contract with
// zero changes to the session domain (`SessionId` / `ChannelId` are consumed,
// not redefined). The runtime `it` block adds a smoke assertion so the compile
// proof is anchored to an executing test.
//
// `isolatedDeclarations` requires explicit return annotations only on EXPORTED
// declarations; this class is test-local (never exported), so the method
// bodies need no extra annotation beyond the interface they satisfy.

class MockProviderDriver implements ProviderDriver {
  public createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    return Promise.resolve({
      providerSessionId: `provider-${params.sessionId}`,
      resumeHandle: "resume-handle-opaque",
    });
  }

  public resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // A successful resume returns the `resumed` variant — carries a binding,
    // never a failure signal (the discriminated union forbids both at once).
    return Promise.resolve({
      status: "resumed",
      bindingId: `binding-for-${params.resumeHandle}`,
    });
  }

  public startRun(_params: StartRunParams): Promise<void> {
    return Promise.resolve();
  }

  public interruptRun(_params: InterruptRunParams): Promise<void> {
    return Promise.resolve();
  }

  public applyIntervention(_params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    return Promise.resolve({ status: "applied" });
  }

  public respondToRequest(_params: RespondToRequestParams): Promise<void> {
    return Promise.resolve();
  }

  public closeSession(_params: CloseSessionParams): Promise<void> {
    return Promise.resolve();
  }

  public listModels(): Promise<ProviderModel[]> {
    return Promise.resolve([{ id: "model-1", name: "Model One", capabilities: ["tool_calls"] }]);
  }

  public listModes(): Promise<ProviderMode[]> {
    return Promise.resolve([{ id: "mode-1", name: "Mode One" }]);
  }

  public getCapabilities(): Promise<GetCapabilitiesResult> {
    const capabilities: DriverCapabilities = {
      // Every flag MUST be answered — `Record<DriverCapabilityFlag, boolean>`
      // is total, the structural form of I-005-2 (no capability inferred from
      // absence). Omitting one is a type error, exercised in AC2 below.
      flags: {
        resume: true,
        steer: true,
        interactive_requests: false,
        mcp: false,
        tool_calls: true,
        reasoning_stream: false,
        model_mutation: false,
      },
      contractVersion: "1.0",
    };
    return Promise.resolve({
      capabilities,
      // `tools` is the INGRESS shape — a driver MAY omit `idempotency_class`;
      // normalization happens at the daemon hydration seam, not here.
      tools: [{ name: "read_file" }, { name: "write_file", idempotency_class: "compensable" }],
    });
  }
}

describe("ProviderDriver contract — AC1 (`Spec-005 §Acceptance Criteria`): a mock implements all 10 ops", () => {
  // Type-level proof that the mock satisfies the contract interface: assigning
  // it to a `ProviderDriver`-typed binding will fail to compile if any of the
  // 10 method signatures drifts from the contract. This is the AC1 assertion;
  // the runtime checks below merely anchor it to an executing test.
  const driver: ProviderDriver = new MockProviderDriver();

  it("is constructable and surfaces all 10 contract operations as callable methods", () => {
    const operationNames = [
      "createSession",
      "resumeSession",
      "startRun",
      "interruptRun",
      "applyIntervention",
      "respondToRequest",
      "closeSession",
      "listModels",
      "listModes",
      "getCapabilities",
    ] as const;
    expect(driver).toBeInstanceOf(MockProviderDriver);
    for (const operationName of operationNames) {
      expect(typeof (driver as unknown as Record<string, unknown>)[operationName]).toBe("function");
    }
  });

  it("createSession resolves the expected ProviderSessionHandle shape (runtime smoke)", async () => {
    const handle = await driver.createSession({ sessionId: SESSION_ID, config: {} });
    expect(handle).toEqual({
      providerSessionId: `provider-${SESSION_UUID}`,
      resumeHandle: "resume-handle-opaque",
    });
  });

  it("getCapabilities answers every one of the 7 flags and returns ingress tools", async () => {
    const result = await driver.getCapabilities();
    // The canonical 7-flag `DriverCapabilityFlag` set, written alphabetically;
    // this literal must stay in lockstep with provider-driver.ts (a flag added
    // or removed there has to be reflected here).
    const canonicalCapabilityFlags = [
      "interactive_requests",
      "mcp",
      "model_mutation",
      "reasoning_stream",
      "resume",
      "steer",
      "tool_calls",
    ];
    // I-005-2 structural check: the flag record is total — exactly the 7
    // canonical flags, every one answered with a boolean.
    expect(Object.keys(result.capabilities.flags).sort()).toEqual(canonicalCapabilityFlags);
    expect(result.tools).toHaveLength(2);
  });

  it("applyIntervention resolves an applied DriverInterventionResult (runtime smoke)", async () => {
    const result = await driver.applyIntervention({
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 3,
      payload: { content: "stay on task" },
    });
    expect(result.status).toBe("applied");
  });

  it("rejects a steer intervention with an empty payload (compile-time, `Spec-005 §Required Behavior`)", () => {
    // @ts-expect-error — `steer` is coupled to SteerPayload; `content` is
    // mandatory, so the empty `payload: {}` below makes this assignment a type
    // error (an empty payload is structurally unrepresentable for `steer`).
    const malformed: ApplyInterventionParams = {
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      payload: {},
    };
    void malformed;
  });

  it("consumes session-domain branded ids without redefining them (no session-domain change)", () => {
    // The contract imports `SessionId` / `ChannelId` from session.ts. Binding
    // the same brands here proves the driver reuses the session domain rather
    // than forking it — the structural form of "no session-domain change".
    const startParams: StartRunParams = {
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {},
    };
    expect(startParams.runId).toBe(RUN_UUID);
    expect(startParams.channelId).toBe(CHANNEL_UUID);
  });

  it("carries the native-cap admitted cap on both the start and resume seams", () => {
    // The omitting fixtures above prove the field is optional; these prove the
    // typed presence form on both seams — recovery must be able to re-thread
    // the run.queued server-stamped cap (campaign B6).
    const cappedStart: StartRunParams = {
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {},
      admittedCostCapCents: 2500,
    };
    const cappedResume: ResumeSessionParams = {
      sessionId: SESSION_ID,
      resumeHandle: "resume-handle-opaque",
      admittedCostCapCents: 2500,
    };
    const cappedCreate: CreateSessionParams = {
      sessionId: SESSION_ID,
      config: {},
      admittedCostCapCents: 2500,
    };
    expect(cappedStart.admittedCostCapCents).toBe(2500);
    expect(cappedResume.admittedCostCapCents).toBe(2500);
    expect(cappedCreate.admittedCostCapCents).toBe(2500);
  });
});

// ===========================================================================
// AC2 (`Spec-005 §Acceptance Criteria`) — a capability flag outside the 7-flag union is a TS error.
// ===========================================================================
//
// `DriverCapabilities.flags` is `Record<DriverCapabilityFlag, boolean>`. The
// `@ts-expect-error` directives below assert the type system REJECTS:
//   (a) an extra flag key not in the 7-member union, and
//   (b) an incomplete record that omits a required flag.
// Self-verifying: an UNUSED `@ts-expect-error` is itself a TS2578 error, so if
// the off-union flag ever became valid (e.g. the union gained `pause`,
// excluded per ADR-011) the full `tsc -p tsconfig.test.json` pass would fail.
// No `as any` / `as never` escape hatch is used — that would silence the very
// error this case exists to surface.

describe("ProviderDriver contract — AC2 (`Spec-005 §Acceptance Criteria`): off-union capability flag is a type error", () => {
  it("rejects a capability flag outside the 7-flag DriverCapabilityFlag union at compile time", () => {
    const flagsWithExtra: DriverCapabilities["flags"] = {
      resume: true,
      steer: true,
      interactive_requests: false,
      mcp: false,
      tool_calls: true,
      reasoning_stream: false,
      model_mutation: false,
      // `pause` is intentionally NOT in the union (ADR-011 models pause as an
      // orchestration-layer construct — interrupt run, persist state, queue
      // resume — not a driver capability and not an `InterventionType` value
      // (`InterventionType = "steer" | "interrupt" | "cancel"`)). An excess key
      // on a `Record<Union, …>` literal is a type error — the directive below
      // MUST consume it.
      // @ts-expect-error pause is not a DriverCapabilityFlag (ADR-011: pause is an orchestration-layer construct — interrupt + persist + queue-resume — not a driver capability)
      pause: true,
    };
    // Runtime read keeps the binding "used" for lint and anchors the type
    // proof to an executing assertion; the load-bearing check is the compile.
    expect(flagsWithExtra.resume).toBe(true);
  });

  it("rejects an incomplete flag record that omits a required capability (I-005-2: totality)", () => {
    // `Record<DriverCapabilityFlag, boolean>` is total: omitting `model_mutation`
    // is a type error, so a driver cannot silently leave a capability
    // unanswered (capabilities are explicit, never inferred from absence).
    // @ts-expect-error missing `model_mutation` — the flag record is total and must answer every flag
    const incompleteFlags: DriverCapabilities["flags"] = {
      resume: true,
      steer: true,
      interactive_requests: false,
      mcp: false,
      tool_calls: true,
      reasoning_stream: false,
    };
    expect(incompleteFlags.resume).toBe(true);
  });
});

// ===========================================================================
// I-005-5 — silent provider-session replacement is structurally inexpressible.
// ===========================================================================
//
// `DriverResumeResult` is a `status`-discriminated union. The `failed` variant
// carries `recoveryCondition: "recovery-needed"` + `providerFailureDetail` and
// has NO `bindingId`; the `resumed` variant carries `bindingId` and no failure
// signal. So a resume CANNOT return a binding while signalling failure — the
// type system forbids conflating a failed resume with a successful one
// (`Spec-005 §Fallback Behavior`: resume failure must surface provider-failure detail + a visible
// recovery-needed condition, and must NOT silently create a replacement
// session under the same canonical run).

describe("ProviderDriver contract — I-005-5: failed resume cannot carry a binding", () => {
  it("forbids accessing `.bindingId` after narrowing to status:'failed' (compile-time)", () => {
    // Parse through the schema so the static type is the genuine
    // `DriverResumeResult` UNION (not a narrow object literal) — this is the
    // sibling idiom (session-event.test.ts narrows a `.parse()` result). It
    // makes the discriminator guard a REAL narrowing: the `@ts-expect-error`
    // below is then checked against the narrowed `failed` variant, where
    // `.bindingId` genuinely does not exist.
    const resume: DriverResumeResult = DriverResumeResultSchema.parse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      providerFailureDetail: "provider endpoint returned 410 Gone",
    });

    if (resume.status === "failed") {
      // The `failed` variant structurally carries the recovery signal.
      expect(resume.recoveryCondition).toBe("recovery-needed");
      expect(resume.providerFailureDetail).toBe("provider endpoint returned 410 Gone");

      // …and CANNOT carry a binding. Accessing `.bindingId` on the narrowed
      // `failed` variant is a type error — the structural proof that silent
      // replacement (a binding alongside a failure) is inexpressible.
      // @ts-expect-error `bindingId` does not exist on the `failed` variant (I-005-5: no binding alongside a failure)
      const leakedBinding = resume.bindingId;
      // `leakedBinding` is `undefined` at runtime (the property is absent); the
      // load-bearing assertion is the compile error consumed above.
      expect(leakedBinding).toBeUndefined();
    } else {
      throw new Error(`expected the failed variant, got status=${resume.status}`);
    }
  });

  it("the resumed variant carries a binding and no failure signal (the other arm)", () => {
    const success: DriverResumeResult = DriverResumeResultSchema.parse({
      status: "resumed",
      bindingId: "binding-xyz",
    });

    if (success.status === "resumed") {
      expect(success.bindingId).toBe("binding-xyz");
      // Symmetric proof: the `resumed` variant has no recovery signal.
      // @ts-expect-error `recoveryCondition` does not exist on the `resumed` variant (I-005-5: success carries no failure signal)
      const leakedRecovery = success.recoveryCondition;
      expect(leakedRecovery).toBeUndefined();
    } else {
      throw new Error(`expected the resumed variant, got status=${success.status}`);
    }
  });
});

// ===========================================================================
// I-005-3 — `ProviderToolMetadataSchema` parse-time idempotency normalization.
// ===========================================================================
//
// This package's first TRANSFORMING schema (Input ≠ Output): an OMITTED
// `idempotency_class` defaults to `manual_reconcile_only` on the OUTPUT (a
// driver may omit it at ingress; the daemon-side normalized shape requires it).
// `Spec-005 §idempotency_class` — an undeclared class is NOT a contract violation; the safe
// default applies at the normalization seam.

describe("ProviderToolMetadataSchema — I-005-3: ingress→normalized idempotency default", () => {
  it("defaults an omitted idempotency_class to 'manual_reconcile_only' at parse time", () => {
    const normalized: NormalizedProviderToolMetadata = ProviderToolMetadataSchema.parse({
      name: "delete_branch",
    });
    expect(normalized.idempotency_class).toBe("manual_reconcile_only");
    expect(normalized.name).toBe("delete_branch");
  });

  it.each(["idempotent", "compensable", "manual_reconcile_only"] as const)(
    "passes an explicitly-declared idempotency_class through unchanged: %s",
    (declaredClass) => {
      const normalized = ProviderToolMetadataSchema.parse({
        name: "list_files",
        idempotency_class: declaredClass,
      });
      expect(normalized.idempotency_class).toBe(declaredClass);
    },
  );

  it("preserves an optional description when present", () => {
    const normalized = ProviderToolMetadataSchema.parse({
      name: "read_file",
      description: "Reads a file from the workspace.",
    });
    expect(normalized.description).toBe("Reads a file from the workspace.");
    // The default still fires for the omitted class alongside a present description.
    expect(normalized.idempotency_class).toBe("manual_reconcile_only");
  });

  it("rejects a missing `name` (the only required ingress field; field surfaced in the issue path)", () => {
    const result = ProviderToolMetadataSchema.safeParse({ idempotency_class: "idempotent" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("name");
    }
  });

  it("rejects an off-enum idempotency_class value", () => {
    expect(
      ProviderToolMetadataSchema.safeParse({ name: "x", idempotency_class: "best_effort" }).success,
    ).toBe(false);
  });

  it("strips an unknown extra key (`Spec-005 §Default Behavior` forward-compat — unknown fields ignored)", () => {
    // The extensible tool-metadata DECLARATION surface must IGNORE unknown keys
    // (`Spec-005 §Default Behavior`), in deliberate contrast to the `.strict()` result envelopes.
    // The load-bearing assertion is ABSENCE of the unknown key from the
    // normalized output (`toEqual`, not a `success`-only check) — a passthrough
    // schema would also `success`, so only checking the exact output shape
    // discriminates "stripped" from "leaked".
    const result = ProviderToolMetadataSchema.safeParse({ name: "read_file", future_field: "x" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        name: "read_file",
        idempotency_class: "manual_reconcile_only",
      });
    }
  });
});

// ===========================================================================
// ProviderToolMetadataSchema — trust-boundary string bounds (wireFreeFormString).
// ===========================================================================
//
// `name` and `description` parse UNTRUSTED provider output. Both are bounded via
// `wireFreeFormString`: empty, whitespace-only, NUL-containing, and over-max
// strings are REJECTED (no truncation). Over-max fixtures are built from the
// EXPORTED `*_MAX_LEN` constant so the test tracks the contract value.

describe("ProviderToolMetadataSchema — untrusted free-form string bounds", () => {
  it("accepts an in-bounds name + description", () => {
    const result = ProviderToolMetadataSchema.safeParse({
      name: "read_file",
      description: "Reads a file from the workspace.",
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_TOOL_NAME_MAX_LEN + 1)],
  ])("rejects a `name` that is %s", (_label, invalidName) => {
    expect(ProviderToolMetadataSchema.safeParse({ name: invalidName }).success).toBe(false);
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_TOOL_DESCRIPTION_MAX_LEN + 1)],
  ])("rejects a `description` that is %s", (_label, invalidDescription) => {
    expect(
      ProviderToolMetadataSchema.safeParse({ name: "read_file", description: invalidDescription })
        .success,
    ).toBe(false);
  });

  // `wireFreeFormString`'s `.max()` is INCLUSIVE — an exactly-MAX_LEN string must
  // be ACCEPTED. Asserting only `MAX_LEN + 1` rejects would let an off-by-one
  // regression (exclusive bound) pass silently; pin the inclusive boundary.
  it("accepts a `name` at exactly DRIVER_TOOL_NAME_MAX_LEN (inclusive boundary)", () => {
    expect(
      ProviderToolMetadataSchema.safeParse({ name: "a".repeat(DRIVER_TOOL_NAME_MAX_LEN) }).success,
    ).toBe(true);
  });

  it("accepts a `description` at exactly DRIVER_TOOL_DESCRIPTION_MAX_LEN (inclusive boundary)", () => {
    expect(
      ProviderToolMetadataSchema.safeParse({
        name: "read_file",
        description: "a".repeat(DRIVER_TOOL_DESCRIPTION_MAX_LEN),
      }).success,
    ).toBe(true);
  });
});

// ===========================================================================
// IdempotencyClassSchema — the leaf enum guard.
// ===========================================================================

describe("IdempotencyClassSchema — the idempotency-class enum", () => {
  it.each(["idempotent", "compensable", "manual_reconcile_only"] as const)(
    "accepts the canonical member: %s",
    (member) => {
      const parsed = IdempotencyClassSchema.parse(member);
      expect(parsed).toBe(member);
    },
  );

  it.each([
    ["off-enum string", "best_effort"],
    ["empty string", ""],
    ["wrong-case member", "Idempotent"],
    ["number", 1],
    ["null", null],
    ["undefined", undefined],
  ])("rejects a non-member value: %s", (_label, value) => {
    expect(IdempotencyClassSchema.safeParse(value).success).toBe(false);
  });
});

// ===========================================================================
// DriverInterventionResultSchema — the applyIntervention result envelope.
// ===========================================================================
//
// Zod-validated because it parses UNTRUSTED provider output (the provider→daemon
// trust boundary). Flat object (not discriminated): `applied` and `degraded`
// differ only by the optional `fallbackAction` hint. `.strict()` rejects any
// unknown key.

describe("DriverInterventionResultSchema — intervention result envelope (trust boundary)", () => {
  it("parses an `applied` result with no fallbackAction", () => {
    const parsed: DriverInterventionResult = DriverInterventionResultSchema.parse({
      status: "applied",
    });
    expect(parsed.status).toBe("applied");
    expect(parsed.fallbackAction).toBeUndefined();
  });

  it("parses a `degraded` result carrying a fallbackAction hint", () => {
    const parsed = DriverInterventionResultSchema.parse({
      status: "degraded",
      fallbackAction: "queue_and_interrupt",
    });
    expect(parsed.status).toBe("degraded");
    expect(parsed.fallbackAction).toBe("queue_and_interrupt");
  });

  it("rejects a status outside the applied | degraded union", () => {
    expect(DriverInterventionResultSchema.safeParse({ status: "exploded" }).success).toBe(false);
  });

  it("rejects an unknown extra key (.strict() guard)", () => {
    expect(
      DriverInterventionResultSchema.safeParse({ status: "applied", extra: "leak" }).success,
    ).toBe(false);
  });

  it("rejects a missing required `status` (field surfaced in the issue path)", () => {
    const result = DriverInterventionResultSchema.safeParse({
      fallbackAction: "queue_and_interrupt",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("status");
    }
  });

  it("rejects a non-string fallbackAction (wrong-type at the trust boundary)", () => {
    expect(
      DriverInterventionResultSchema.safeParse({ status: "degraded", fallbackAction: 123 }).success,
    ).toBe(false);
  });

  it("accepts an in-bounds fallbackAction hint", () => {
    expect(
      DriverInterventionResultSchema.safeParse({
        status: "degraded",
        fallbackAction: "queue_and_interrupt",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_FALLBACK_ACTION_MAX_LEN + 1)],
  ])("rejects a `fallbackAction` that is %s (wireFreeFormString bound)", (_label, invalidValue) => {
    expect(
      DriverInterventionResultSchema.safeParse({ status: "degraded", fallbackAction: invalidValue })
        .success,
    ).toBe(false);
  });

  // Inclusive `.max()`: an exactly-MAX_LEN fallbackAction must be ACCEPTED
  // (guards against an off-by-one exclusive-bound regression).
  it("accepts a `fallbackAction` at exactly DRIVER_FALLBACK_ACTION_MAX_LEN (inclusive boundary)", () => {
    expect(
      DriverInterventionResultSchema.safeParse({
        status: "degraded",
        fallbackAction: "a".repeat(DRIVER_FALLBACK_ACTION_MAX_LEN),
      }).success,
    ).toBe(true);
  });
});

// ===========================================================================
// DriverResumeResultSchema — the resumeSession result envelope.
// ===========================================================================
//
// Zod-validated provider output. Discriminated over `status`: the `resumed` arm
// requires `bindingId`; the `failed` arm requires `recoveryCondition` (the
// `recovery-needed` literal) + `providerFailureDetail`. Each arm is `.strict()`,
// so a binding cannot ride along on a failure (the runtime mirror of I-005-5).

describe("DriverResumeResultSchema — resume result envelope (trust boundary; I-005-5)", () => {
  it("parses the `resumed` arm with a bindingId", () => {
    const parsed: DriverResumeResult = DriverResumeResultSchema.parse({
      status: "resumed",
      bindingId: "binding-abc",
    });
    expect(parsed.status).toBe("resumed");
    if (parsed.status === "resumed") {
      expect(parsed.bindingId).toBe("binding-abc");
    }
  });

  it("parses the `failed` arm with recoveryCondition + providerFailureDetail", () => {
    const parsed = DriverResumeResultSchema.parse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      providerFailureDetail: "provider session expired",
    });
    expect(parsed.status).toBe("failed");
    if (parsed.status === "failed") {
      expect(parsed.recoveryCondition).toBe("recovery-needed");
      expect(parsed.providerFailureDetail).toBe("provider session expired");
    }
  });

  it("rejects a `resumed` object missing bindingId (field surfaced in the issue path)", () => {
    const result = DriverResumeResultSchema.safeParse({ status: "resumed" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("bindingId");
    }
  });

  it("rejects a `failed` object missing providerFailureDetail (field surfaced in the issue path)", () => {
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "recovery-needed",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("providerFailureDetail");
    }
  });

  it("rejects a `failed` object missing recoveryCondition (field surfaced in the issue path)", () => {
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      providerFailureDetail: "provider session expired",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("recoveryCondition");
    }
  });

  it("rejects a `failed` object whose recoveryCondition is not the `recovery-needed` literal (cause surfaced on recoveryCondition)", () => {
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "all-good",
      providerFailureDetail: "provider session expired",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The defect is the wrong literal on `recoveryCondition`, not a missing
      // field — assert the issue is attributed to that exact path.
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("recoveryCondition");
    }
  });

  it("rejects silent replacement — a `failed` object carrying a bindingId (.strict() arm guard; unrecognized key surfaced)", () => {
    // The runtime mirror of the I-005-5 compile proof above: a failed resume
    // that smuggles a `bindingId` is rejected because the `failed` arm is
    // `.strict()` and `bindingId` is not one of its keys. So neither the type
    // system NOR the runtime schema lets a failure carry a binding.
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      providerFailureDetail: "provider session expired",
      bindingId: "binding-smuggled",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The rejection cause is specifically the smuggled `bindingId` key. A
      // `.strict()` rejection raises an `unrecognized_keys` issue whose path is
      // the object root (`[]`) and whose offending key names live on
      // `issue.keys` — so assert against `keys`, not `path`. This pins the
      // cause: a future fixture that grew a DIFFERENT defect cannot pass while
      // silently no longer exercising the binding-smuggle it claims to guard.
      const unrecognizedKeyIssue = result.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect(unrecognizedKeyIssue).toBeDefined();
      expect((unrecognizedKeyIssue as { keys?: readonly string[] })?.keys).toContain("bindingId");
    }
  });

  it("rejects a `resumed` object whose bindingId is a non-string (wrong-type at the trust boundary)", () => {
    expect(DriverResumeResultSchema.safeParse({ status: "resumed", bindingId: 42 }).success).toBe(
      false,
    );
  });

  it("rejects a `failed` object whose providerFailureDetail is null (wrong-type at the trust boundary)", () => {
    expect(
      DriverResumeResultSchema.safeParse({
        status: "failed",
        recoveryCondition: "recovery-needed",
        providerFailureDetail: null,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown status discriminator value", () => {
    expect(DriverResumeResultSchema.safeParse({ status: "pending" }).success).toBe(false);
  });

  // wireFreeFormString bounds on the two untrusted free-form strings this
  // envelope persists / surfaces. `bindingId` carries `/\S/` + NUL guards as
  // defense-in-depth because it lands in `runtime_bindings` and on events — a
  // different rationale from the human-field guards, not a "stronger is better"
  // claim (see the schema comment in provider-driver.ts).

  it("accepts an in-bounds bindingId on the resumed arm", () => {
    expect(
      DriverResumeResultSchema.safeParse({ status: "resumed", bindingId: "binding-abc" }).success,
    ).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_BINDING_ID_MAX_LEN + 1)],
  ])("rejects a `bindingId` that is %s (wireFreeFormString bound)", (_label, invalidValue) => {
    expect(
      DriverResumeResultSchema.safeParse({ status: "resumed", bindingId: invalidValue }).success,
    ).toBe(false);
  });

  it("accepts an in-bounds providerFailureDetail on the failed arm", () => {
    expect(
      DriverResumeResultSchema.safeParse({
        status: "failed",
        recoveryCondition: "recovery-needed",
        providerFailureDetail: "provider session expired",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_FAILURE_DETAIL_MAX_LEN + 1)],
  ])(
    "rejects a `providerFailureDetail` that is %s (wireFreeFormString bound)",
    (_label, invalidValue) => {
      expect(
        DriverResumeResultSchema.safeParse({
          status: "failed",
          recoveryCondition: "recovery-needed",
          providerFailureDetail: invalidValue,
        }).success,
      ).toBe(false);
    },
  );

  // Inclusive `.max()` on both envelope strings: an exactly-MAX_LEN value must be
  // ACCEPTED (guards the inclusive boundary against an off-by-one regression).
  it("accepts a `bindingId` at exactly DRIVER_BINDING_ID_MAX_LEN (inclusive boundary)", () => {
    expect(
      DriverResumeResultSchema.safeParse({
        status: "resumed",
        bindingId: "a".repeat(DRIVER_BINDING_ID_MAX_LEN),
      }).success,
    ).toBe(true);
  });

  it("accepts a `providerFailureDetail` at exactly DRIVER_FAILURE_DETAIL_MAX_LEN (inclusive boundary)", () => {
    expect(
      DriverResumeResultSchema.safeParse({
        status: "failed",
        recoveryCondition: "recovery-needed",
        providerFailureDetail: "a".repeat(DRIVER_FAILURE_DETAIL_MAX_LEN),
      }).success,
    ).toBe(true);
  });
});
