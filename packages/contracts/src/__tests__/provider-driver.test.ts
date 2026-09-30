// Contract tests for the provider-driver seam: the refinements, defaults and derived shapes that
// carry logic, and the identity, idempotency and fail-open guards a driver or client could
// otherwise break. Runtime guards are proven by `.safeParse()`; nominal guards by
// `@ts-expect-error`, which fails as unused (TS2578) if the guarded shape loosens.
import { describe, expect, it } from "vitest";

import {
  DriverInterventionResultSchema,
  ProviderToolMetadataSchema,
  type ApplyInterventionParams,
  type DriverInterventionResult,
  type ExecutionPosture,
  type NormalizedProviderToolMetadata,
  type RunId,
} from "../provider-driver.js";
import {
  CompactContextRequestSchema,
  ListProviderCommandsRequestSchema,
} from "../provider-driver-wire.js";

// Real RFC 9562 UUIDs; the brands are type-only, so the runtime value is a plain string.
const SESSION_UUID = "550e8400-e29b-41d4-a716-446655440000";
const RUN_UUID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";

const RUN_ID = RUN_UUID as RunId;

// An omitted `idempotency_class` defaults to `manual_reconcile_only`, so a tool that declares
// nothing is never treated as safe to replay.

describe("ProviderToolMetadataSchema: ingress→normalized idempotency default", () => {
  it("defaults an omitted idempotency_class to 'manual_reconcile_only' at parse time", () => {
    const normalized: NormalizedProviderToolMetadata = ProviderToolMetadataSchema.parse({
      name: "delete_branch",
    });
    expect(normalized.idempotency_class).toBe("manual_reconcile_only");
    expect(normalized.name).toBe("delete_branch");
  });
});

describe("DriverInterventionResultSchema — intervention result envelope (trust boundary)", () => {
  it("parses a `degraded` result carrying the text-neutralization refusal code", () => {
    const parsed: DriverInterventionResult = DriverInterventionResultSchema.parse({
      status: "degraded",
      refusalCode: "driver.text_neutralization_failed",
    });
    expect(parsed.refusalCode).toBe("driver.text_neutralization_failed");
    // No fallbackAction: a refusal names no alternative the caller could take.
    expect(parsed.fallbackAction).toBeUndefined();
  });

  it("rejects the refusal code beside status 'applied' (cross-field contradiction)", () => {
    // The code says the user's text was swallowed, which `applied` denies; accepted, the two
    // fields would disagree.
    const result = DriverInterventionResultSchema.safeParse({
      status: "applied",
      refusalCode: "driver.text_neutralization_failed",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("refusalCode");
    }
  });
});

// `clientIdempotencyKey` is mandatory on every dispatch arm: the requester-generated UUID the
// daemon dedupes on turns at-least-once delivery into exactly-once application. Each arm declares
// it separately, so all three omissions are proven.

describe("ApplyInterventionParams — clientIdempotencyKey is mandatory", () => {
  it("forbids omitting the key on the steer, interrupt and cancel arms", () => {
    // @ts-expect-error clientIdempotencyKey is required
    const steerWithoutKey: ApplyInterventionParams = {
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      payload: { content: "stay on task" },
    };
    void steerWithoutKey;

    // @ts-expect-error clientIdempotencyKey is required on the interrupt arm too
    const interruptWithoutKey: ApplyInterventionParams = {
      type: "interrupt",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      payload: { reason: "operator halt" },
    };
    void interruptWithoutKey;

    // @ts-expect-error clientIdempotencyKey is required on the cancel arm too
    const cancelWithoutKey: ApplyInterventionParams = {
      type: "cancel",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      payload: { reason: "superseded" },
    };
    void cancelWithoutKey;
  });
});

describe("ExecutionPosture — no fail-open shape", () => {
  it("forbids a fail-open allow-list and a sandbox with no credential policy", () => {
    // The tuple annotation matters: a bare array literal widens to `string[]`, and TS would
    // report an arity mismatch on the property instead of the exclusion.
    // @ts-expect-error allowedDomains is absent unless networkAccess is "allowed-domains"
    const allowListOutsideItsMode: ExecutionPosture = {
      networkAccess: "none",
      allowedDomains: ["api.example.test"] as [string, ...string[]],
      writableRoots: [],
      mode: "trusted",
    };
    void allowListOutsideItsMode;

    const emptyAllowList: ExecutionPosture = {
      networkAccess: "allowed-domains",
      // @ts-expect-error allowedDomains must be non-empty
      allowedDomains: [],
      writableRoots: [],
      mode: "trusted",
    };
    void emptyAllowList;

    // @ts-expect-error credentialPolicyRef is required on both sandboxed modes
    const sandboxedWithoutCredentialPolicy: ExecutionPosture = {
      networkAccess: "full",
      writableRoots: ["/workspace"],
      mode: "workspace-sandboxed",
    };
    void sandboxedWithoutCredentialPolicy;
  });
});

describe("CompactContext and ListProviderCommands requests — no binding member", () => {
  const AGENT_UUID = "770e8400-e29b-41d4-a716-446655440002";
  const compactRequest = { sessionId: SESSION_UUID, runId: RUN_UUID };
  const listRequest = { sessionId: SESSION_UUID, agentId: AGENT_UUID };

  it("accepts the canonical session-scoped pair on both requests", () => {
    expect(CompactContextRequestSchema.parse(compactRequest)).toEqual(compactRequest);
    expect(ListProviderCommandsRequestSchema.parse(listRequest)).toEqual(listRequest);
  });

  it("REFUSES a bindingId beside either pair — the wire admits NO binding member", () => {
    // The client surface publishes no `bindingId`, and `.strict()` makes that a refusal: a
    // caller naming a binding believes it holds an addressing key the daemon never handed out,
    // and an ignored key would leave it believing the dispatch was binding-routed.
    expect(
      CompactContextRequestSchema.safeParse({ ...compactRequest, bindingId: "binding-1" }).success,
    ).toBe(false);
    expect(
      ListProviderCommandsRequestSchema.safeParse({ ...listRequest, bindingId: "binding-1" })
        .success,
    ).toBe(false);
  });
});
