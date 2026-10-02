// The provider-driver seam's refinements and defaults: the rules a driver or client could
// otherwise break by sending a shape the daemon then trusts.
import { describe, expect, it } from "vitest";

import {
  ArtifactIdSchema,
  DriverInterventionResultSchema,
  ProviderToolMetadataSchema,
  type DriverInterventionResult,
  type NormalizedProviderToolMetadata,
} from "../provider-driver.js";
import { DriverCompactionResultSchema } from "../provider-driver-transcript.js";
import {
  CompactContextRequestSchema,
  ListProviderCommandsRequestSchema,
} from "../provider-driver-wire.js";

// Real RFC 9562 UUIDs; the brands are type-only, so the runtime value is a plain string.
const SESSION_UUID = "550e8400-e29b-41d4-a716-446655440000";
const RUN_UUID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const AN_ARTIFACT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";

describe("DriverCompactionResultSchema — the two structural rules, made checkable", () => {
  // The compaction result is composed daemon-side from the wait's own settlement, so no dispatch
  // path parses through this schema. It exists so the two rules are enforced by the type; a later
  // widening that broke either fails here.

  it("REQUIRES `boundaryPosition` on the applied arm", () => {
    // A compaction with no boundary is one the driver cannot prove: the boundary row is the
    // typed evidence, and without it the operation could settle on the request merely having
    // been accepted.
    expect(DriverCompactionResultSchema.safeParse({ status: "applied" }).success).toBe(false);
    expect(
      DriverCompactionResultSchema.safeParse({ status: "applied", boundaryPosition: 12 }).success,
    ).toBe(true);
  });

  it("admits `capability_undeclared` as NO arm's reason", () => {
    // The static capability gate refuses an undeclared compaction before the driver is called,
    // so an arm for it would be a second, contradictory encoding of one refusal. Both
    // refusal-shaped arms are probed so the reason cannot pass by landing on the other.
    expect(
      DriverCompactionResultSchema.safeParse({
        status: "refused",
        reason: "capability_undeclared",
      }).success,
    ).toBe(false);
    expect(
      DriverCompactionResultSchema.safeParse({
        status: "failed",
        reason: "capability_undeclared",
      }).success,
    ).toBe(false);
  });
});

describe("ArtifactIdSchema — the attachment element brand", () => {
  it("accepts a UUID and brands it", () => {
    expect(ArtifactIdSchema.parse(AN_ARTIFACT_ID)).toBe(AN_ARTIFACT_ID);
  });

  it("REFUSES a non-UUID artifact id", () => {
    // The value reaches an artifact manifest lookup, so a path or store-key fragment must not
    // arrive as one.
    expect(ArtifactIdSchema.safeParse("../../etc/passwd").success).toBe(false);
    expect(ArtifactIdSchema.safeParse("artifact-1").success).toBe(false);
    expect(ArtifactIdSchema.safeParse("").success).toBe(false);
  });
});

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
