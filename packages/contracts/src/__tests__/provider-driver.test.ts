// Contract tests for the provider-driver seam: the refinements, defaults and derived shapes that
// carry logic, and the identity, idempotency and fail-open guards a driver or client could
// otherwise break. Runtime guards are proven by `.safeParse()`; nominal guards by
// `@ts-expect-error`, which fails as unused (TS2578) if the guarded shape loosens.
import { describe, expect, it } from "vitest";

import {
  DriverCompactionResultSchema,
  DriverTranscriptReplayResultSchema,
  type DriverTranscriptReplayResult,
} from "../provider-driver-transcript.js";
import {
  ArtifactIdSchema,
  DRIVER_CAPABILITY_FLAGS,
  DRIVER_MCP_SERVER_NAME_MAX_LEN,
  DriverInterventionResultSchema,
  McpServerStatusEmissionSchema,
  ProviderToolMetadataSchema,
  type ApplyInterventionParams,
  type DriverCapabilities,
  type DriverInterventionResult,
  type DriverTransportConfig,
  type ExecutionPosture,
  type NormalizedProviderToolMetadata,
  type RunId,
} from "../provider-driver.js";
import {
  CompactContextRequestSchema,
  ListProviderCommandsRequestSchema,
} from "../provider-driver-wire.js";
import {
  DriverResumeResultSchema,
  type DriverResumeResult,
  type ProviderUsageLimitCause,
  type RecoveryCondition,
} from "../provider-driver-recovery.js";
import * as contracts from "../index.js";

// Real RFC 9562 UUIDs; the brands are type-only, so the runtime value is a plain string.
const SESSION_UUID = "550e8400-e29b-41d4-a716-446655440000";
const RUN_UUID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";

const RUN_ID = RUN_UUID as RunId;
const AN_ARTIFACT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";

// `DriverCapabilities.flags` is `Record<DriverCapabilityFlag, boolean>`, so an extra key and an
// incomplete record are both type errors. An unused `@ts-expect-error` is itself a TS2578 error, so
// the check fails if either ever became valid.

describe("ProviderDriver contract: the capability flag record is closed and total", () => {
  it("rejects a capability flag outside the DriverCapabilityFlag union at compile time", () => {
    const flagsWithExtra: DriverCapabilities["flags"] = {
      resume: true,
      steer: true,
      interactive_requests: false,
      mcp: false,
      tool_calls: true,
      reasoning_stream: false,
      model_mutation: false,
      structured_output: false,
      rollback: false,
      session_goals: false,
      callback_tools: false,
      subagents: false,
      transcript_replay: false,
      context_compaction: false,
      provider_commands: false,
      output_speed: false,
      // `pause` is not a driver capability (it is an orchestration-layer construct) and not an
      // intervention type. An excess key on a `Record<Union, …>` literal is a type error.
      // @ts-expect-error pause is not a DriverCapabilityFlag
      pause: true,
    };
    // The runtime read keeps the binding used; the compile is the check.
    expect(flagsWithExtra.resume).toBe(true);
  });

  it("rejects an incomplete flag record that omits a required capability (totality)", () => {
    // The flag record is total, so a driver cannot leave a capability unanswered. Omitting the
    // three newest flags shows totality covers the whole union, not only the original flags.
    // @ts-expect-error the flag record is total and must answer every flag
    const incompleteFlags: DriverCapabilities["flags"] = {
      resume: true,
      steer: true,
      interactive_requests: false,
      mcp: false,
      tool_calls: true,
      reasoning_stream: false,
      model_mutation: false,
      structured_output: false,
      rollback: false,
      session_goals: false,
      callback_tools: false,
      subagents: false,
      transcript_replay: false,
    };
    expect(incompleteFlags.resume).toBe(true);
  });
});

// Silent provider-session replacement is inexpressible: `DriverResumeResult` is a
// `status`-discriminated union. `failed` carries the recovery condition, span classification
// and failure detail but no `bindingId` or `sessionPosition`; `resumed` carries those two and
// neither failure axis. A failed resume must surface the failure, never quietly create a
// replacement session under the same run.

describe("ProviderDriver contract: failed resume cannot carry a binding", () => {
  it("parses the `failed` arm with both recovery axes + providerFailureDetail", () => {
    const parsed = DriverResumeResultSchema.parse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "read_only",
      providerFailureDetail: "provider session expired",
    });
    expect(parsed.status).toBe("failed");
    if (parsed.status === "failed") {
      expect(parsed.recoveryCondition).toBe("recovery-needed");
      expect(parsed.recoverySpanClassification).toBe("read_only");
      expect(parsed.providerFailureDetail).toBe("provider session expired");
    }
  });

  it("rejects silent replacement — a `failed` object carrying a bindingId", () => {
    // The `failed` arm is `.strict()`, so a smuggled `bindingId` is rejected at runtime as well
    // as by the type.
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "provider session expired",
      bindingId: "binding-smuggled",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // A `.strict()` rejection is an `unrecognized_keys` issue at the object root with the
      // offending names on `issue.keys`, so assert on `keys`; that pins the cause to the
      // smuggled `bindingId`.
      const unrecognizedKeyIssue = result.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect(unrecognizedKeyIssue).toBeDefined();
      expect((unrecognizedKeyIssue as { keys?: readonly string[] })?.keys).toContain("bindingId");
    }
  });

  it("forbids accessing `.bindingId` after narrowing to status:'failed' (compile-time)", () => {
    // Parse through the schema so the static type is the full `DriverResumeResult` union; the
    // `@ts-expect-error` below is then checked against the narrowed `failed` variant.
    const resume: DriverResumeResult = DriverResumeResultSchema.parse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "provider endpoint returned 410 Gone",
    });

    if (resume.status === "failed") {
      expect(resume.recoveryCondition).toBe("recovery-needed");
      expect(resume.recoverySpanClassification).toBe("irreversible");
      expect(resume.providerFailureDetail).toBe("provider endpoint returned 410 Gone");

      // A binding on the `failed` variant is a type error: silent replacement is inexpressible.
      // @ts-expect-error bindingId does not exist on the failed variant
      const leakedBinding = resume.bindingId;
      // Nor a position: a failed resume confirms none for the daemon to compare.
      // @ts-expect-error sessionPosition does not exist on the failed variant
      const leakedPosition = resume.sessionPosition;
      // Both are undefined at runtime; the compile errors above are the check.
      expect(leakedBinding).toBeUndefined();
      expect(leakedPosition).toBeUndefined();
    } else {
      throw new Error(`expected the failed variant, got status=${resume.status}`);
    }
  });
});

describe("DriverResumeResultSchema — the recovery condition is a closed vocabulary", () => {
  it.each(["recovery-needed", "reauth-required"] as const)(
    "accepts the %s condition on the failed variant",
    (recoveryCondition) => {
      const parsed: DriverResumeResult = DriverResumeResultSchema.parse({
        status: "failed",
        recoveryCondition,
        recoverySpanClassification: "unclassifiable",
        providerFailureDetail: "provider credential expired",
      });
      if (parsed.status === "failed") {
        expect(parsed.recoveryCondition).toBe(recoveryCondition);
      } else {
        throw new Error(`expected the failed variant, got status=${parsed.status}`);
      }
    },
  );

  it("rejects a `failed` object whose recoveryCondition is not a RecoveryCondition member", () => {
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "all-good",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "provider session expired",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The defect is an off-union value, not a missing field, so assert the issue's path.
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("recoveryCondition");
    }
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

describe("McpServerStatusEmissionSchema — MCP status producer seam", () => {
  it("accepts a well-formed emission, serverName at its length bound", () => {
    expect(
      McpServerStatusEmissionSchema.safeParse({
        serverName: "a".repeat(DRIVER_MCP_SERVER_NAME_MAX_LEN),
        status: "connected",
      }).success,
    ).toBe(true);
  });

  it("rejects a driver-supplied leg identity — the daemon stamps it", () => {
    // The daemon stamps leg identity; a driver that attributes its emission to another leg is
    // rejected outright, not stripped.
    const result = McpServerStatusEmissionSchema.safeParse({
      serverName: "filesystem",
      status: "connected",
      bindingId: "binding-of-another-leg",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognizedKeyIssue = result.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect((unrecognizedKeyIssue as { keys?: readonly string[] })?.keys).toContain("bindingId");
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

describe("ExecutionPosture / DriverTransportConfig — no fail-open shape", () => {
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

  it("forbids an unauthenticated websocket DriverTransportConfig", () => {
    const stdio: DriverTransportConfig = { transport: "stdio" };
    expect(stdio.transport).toBe("stdio");
    // @ts-expect-error the websocket arm requires a bearerTokenRef
    const unauthenticated: DriverTransportConfig = {
      transport: "websocket",
      endpoint: "ws://127.0.0.1:7000",
    };
    void unauthenticated;
  });
});

describe("DriverTranscriptReplayResultSchema — the canonical transcript replay envelope", () => {
  it("carries the declared-loss list on BOTH status arms", () => {
    const applied: DriverTranscriptReplayResult = DriverTranscriptReplayResultSchema.parse({
      status: "applied",
      declaredLosses: ["provider_private_reasoning"],
    });
    const degraded: DriverTranscriptReplayResult = DriverTranscriptReplayResultSchema.parse({
      status: "degraded",
      declaredLosses: ["conversation_history_summarized"],
    });
    expect(applied.declaredLosses).toEqual(["provider_private_reasoning"]);
    expect(degraded.declaredLosses).toEqual(["conversation_history_summarized"]);
  });

  it("rejects a degraded replay that omits the summarization, empty list or not", () => {
    // An empty list claims nothing was dropped, which would tell a caller the memo summary is
    // the verbatim conversation.
    const emptyDegraded = DriverTranscriptReplayResultSchema.safeParse({
      status: "degraded",
      declaredLosses: [],
    });
    expect(emptyDegraded.success).toBe(false);

    // A merely non-empty rule would let this through: losses are named but not the
    // summarization.
    const degradedWithoutSummarization = DriverTranscriptReplayResultSchema.safeParse({
      status: "degraded",
      declaredLosses: ["provider_private_reasoning", "tool_call_history_repaired"],
    });
    expect(degradedWithoutSummarization.success).toBe(false);
  });

  it("rejects an applied replay declaring the summarization, alone or not", () => {
    // The summarization kind names the memo floor standing in for the conversation, which is the
    // degraded settlement. A result claiming both native replay and a summary is contradictory,
    // and a consumer reading `status` would publish native-replay continuity for a session
    // holding only a bounded summary.
    const appliedWithSummarization = DriverTranscriptReplayResultSchema.safeParse({
      status: "applied",
      declaredLosses: ["conversation_history_summarized"],
    });
    expect(appliedWithSummarization.success).toBe(false);

    // Stripping private reasoning is an ordinary applied loss, and listing it alongside does not
    // launder the contradiction.
    const appliedWithSummarizationBesideOthers = DriverTranscriptReplayResultSchema.safeParse({
      status: "applied",
      declaredLosses: ["provider_private_reasoning", "conversation_history_summarized"],
    });
    expect(appliedWithSummarizationBesideOthers.success).toBe(false);
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

  it("is re-exported from the package barrel under its own name", () => {
    // Every consumer imports this symbol rather than declaring a sibling, so there is one
    // source of truth for what an artifact id is.
    expect(contracts.ArtifactIdSchema).toBe(ArtifactIdSchema);
  });
});

describe("ProviderUsageLimitSignal — a sibling axis, never a RecoveryCondition member", () => {
  it("keeps the two cause vocabularies mutually unassignable in BOTH directions", () => {
    // A `RecoveryCondition` must never carry the usage-limit cause; that is a claim about types,
    // so it is asserted where it can fail. These lines break the build if either union grows
    // into the other, which would route a self-clearing pause into the operator-remediation
    // queue. Both directions are checked: a one-way check would pass if `RecoveryCondition`
    // were widened to contain the cause.
    // @ts-expect-error — a usage-limit cause is not a recovery condition.
    const conditionFromCause: RecoveryCondition = "plan-allowance-exhausted";
    // @ts-expect-error — a recovery condition is not a usage-limit cause.
    const causeFromCondition: ProviderUsageLimitCause = "reauth-required";
    void conditionFromCause;
    void causeFromCondition;

    // The runtime companion: the value sets are disjoint too, so a consumer switching on one can
    // never fall into the other's arm.
    const recoveryConditions: readonly RecoveryCondition[] = ["recovery-needed", "reauth-required"];
    const usageLimitCauses: readonly ProviderUsageLimitCause[] = ["plan-allowance-exhausted"];
    for (const cause of usageLimitCauses) {
      expect(recoveryConditions).not.toContain(cause as string);
    }
  });

  it("adds no capability flag for it — recognizing a usage limit is every driver's duty", () => {
    // A flag would let a driver declare the obligation away, leaving a run refused for spend in
    // the generic failure path with nothing saying why.
    expect(DRIVER_CAPABILITY_FLAGS).toHaveLength(16);
    for (const flag of DRIVER_CAPABILITY_FLAGS) {
      expect(flag).not.toMatch(/usage|limit|rate/);
    }
  });
});
