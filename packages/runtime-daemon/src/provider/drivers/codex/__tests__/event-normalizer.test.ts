// Codex event normalizer: every pinned Codex inbound method resolves to an `EventCategory` and a
// `SessionEventType`, and an unmapped method never resolves to a fabricated one.
//
// - Family coverage is asserted from both sides: which of the six required normalized families
//   the pinned inbound census reaches, and which it provably does not.
// - The two `__fixtures__/` modules are method vectors from the pinned census at
//   `codex-cli 0.150.1`, not payload golden files; no inbound payload body is reproduced.
// - The typed-constructor test stays beside the census-driven `it.each` because it binds each
//   literal to `CodexInboundFrameMethod` at compile time, which a mapping to strings cannot.

import {
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SESSION_EVENT_TYPES,
  type EventCategory,
  type SessionEventType,
} from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  CODEX_GATED_SERVER_NOTIFICATION_COUNT_AT_PIN,
  CODEX_SERVER_NOTIFICATION_COUNT_AT_PIN,
  CODEX_SERVER_NOTIFICATION_METHOD_VECTORS,
} from "../__fixtures__/server-notification-methods.js";
import {
  CODEX_SERVER_REQUEST_METHOD_COUNT_AT_PIN,
  CODEX_SERVER_REQUEST_METHOD_VECTORS,
} from "../__fixtures__/server-request-methods.js";
import { CODEX_NEGOTIATION_GATED_METHODS } from "../event-normalizer.js";
import {
  CODEX_FRAME_NORMALIZATION_BY_METHOD,
  CODEX_INBOUND_FRAME_METHODS,
  CODEX_TOOL_KEYED_APPROVAL_METHODS,
  normalizeCodexInboundFrame,
  resolveCodexEmissionReadiness,
  UnknownCodexInboundFrameError,
  type CodexFrameNormalization,
  type CodexInboundFrameMethod,
  type CodexInboundFrameTransport,
  type CodexNormalizedFamilyEmission,
} from "../event-normalizer.js";
import { CodexTerminalEmissionGate, type CodexTerminalRunFrame } from "../turn-evidence.js";
import { DriverDiagnosticsEmitter } from "../../../driver-diagnostics.js";
import {
  classifyCodexFrameFamilyForRouting,
  CODEX_SUBAGENT_ATTRIBUTED_THREAD_SOURCE_KINDS,
  CODEX_THREAD_STARTED_METHOD,
  CODEX_THREAD_TOKEN_USAGE_METHOD,
  deriveCodexChildThreadAnnouncement,
  resolveCodexFrameEmissionRoute,
} from "../event-normalizer.js";
import {
  classifyCodexUsageLimitSignal,
  CODEX_ACCOUNT_RATE_LIMITS_READ_METHOD,
  CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD,
  CODEX_RATE_LIMIT_REACHED_TYPES,
  CODEX_USAGE_LIMIT_EXCLUDED_REACHED_TYPES,
} from "../usage-limit-signal.js";
import { CODEX_TOOL_NAMES } from "../tools.js";
import { EVENT_DISPOSITION_BY_KIND } from "../../../event-disposition.js";

// The expectation table, written independently of the production record.
//
// A second, hand-written statement of the mapping rather than one derived from
// `CODEX_FRAME_NORMALIZATION_BY_METHOD`: expectations read out of the table under test would only
// prove that a Map round-trips.

interface ExpectedNormalizedRow {
  readonly transport: CodexInboundFrameTransport;
  readonly family: EventCategory;
  readonly eventType: SessionEventType;
  readonly normalizedKind: string | null;
}

const EXPECTED_NORMALIZED_ROWS: ReadonlyMap<CodexInboundFrameMethod, ExpectedNormalizedRow> =
  new Map([
    // ServerRequest: the callback tool, two questions and five approval asks.
    [
      "item/tool/call",
      {
        transport: "server-request",
        family: "tool_activity",
        eventType: "tool.invoked",
        normalizedKind: "tool_start",
      },
    ],
    [
      "item/tool/requestUserInput",
      {
        transport: "server-request",
        family: "interactive_request",
        eventType: "question.asked",
        normalizedKind: "user_input_request",
      },
    ],
    [
      "mcpServer/elicitation/request",
      {
        transport: "server-request",
        family: "interactive_request",
        eventType: "question.asked",
        normalizedKind: "user_input_request",
      },
    ],
    [
      "item/commandExecution/requestApproval",
      {
        transport: "server-request",
        family: "approval_flow",
        eventType: "approval.requested",
        normalizedKind: "approval_request",
      },
    ],
    [
      "item/fileChange/requestApproval",
      {
        transport: "server-request",
        family: "approval_flow",
        eventType: "approval.requested",
        normalizedKind: "approval_request",
      },
    ],
    [
      "item/permissions/requestApproval",
      {
        transport: "server-request",
        family: "approval_flow",
        eventType: "approval.requested",
        normalizedKind: "approval_request",
      },
    ],
    [
      "execCommandApproval",
      {
        transport: "server-request",
        family: "approval_flow",
        eventType: "approval.requested",
        normalizedKind: "approval_request",
      },
    ],
    [
      "applyPatchApproval",
      {
        transport: "server-request",
        family: "approval_flow",
        eventType: "approval.requested",
        normalizedKind: "approval_request",
      },
    ],
    [
      "error",
      {
        transport: "server-notification",
        family: "run_lifecycle",
        eventType: "run.failed",
        normalizedKind: "error",
      },
    ],
    [
      "warning",
      {
        transport: "server-notification",
        family: "session_lifecycle",
        eventType: "session.notice",
        normalizedKind: "notification",
      },
    ],
    [
      "configWarning",
      {
        transport: "server-notification",
        family: "session_lifecycle",
        eventType: "session.notice",
        normalizedKind: "notification",
      },
    ],
    [
      "deprecationNotice",
      {
        transport: "server-notification",
        family: "session_lifecycle",
        eventType: "session.notice",
        normalizedKind: "notification",
      },
    ],
    // Codex's own reviewer: a warning or required review flags; a completed review denies.
    [
      "guardianWarning",
      {
        transport: "server-notification",
        family: "approval_flow",
        eventType: "moderation.review_flagged",
        normalizedKind: null,
      },
    ],
    [
      "item/autoApprovalReview/completed",
      {
        transport: "server-notification",
        family: "approval_flow",
        eventType: "approval.reviewer_denied",
        normalizedKind: null,
      },
    ],
    [
      "autoApprovalReview/strictReviewRequired",
      {
        transport: "server-notification",
        family: "approval_flow",
        eventType: "moderation.review_flagged",
        normalizedKind: null,
      },
    ],
    // Goals.
    [
      "thread/goal/updated",
      {
        transport: "server-notification",
        family: "session_lifecycle",
        eventType: "session.goal_updated",
        normalizedKind: null,
      },
    ],
    [
      "thread/goal/cleared",
      {
        transport: "server-notification",
        family: "session_lifecycle",
        eventType: "session.goal_cleared",
        normalizedKind: null,
      },
    ],
    // Usage telemetry.
    [
      "account/rateLimits/updated",
      {
        transport: "server-notification",
        family: "usage_telemetry",
        eventType: "usage.rate_limit_update",
        normalizedKind: "rate_limits",
      },
    ],
    [
      "thread/compacted",
      {
        transport: "server-notification",
        family: "usage_telemetry",
        eventType: "usage.context_compacted",
        normalizedKind: "compact_boundary",
      },
    ],
    // `process/*` output and exit.
    [
      "process/outputDelta",
      {
        transport: "server-notification",
        family: "tool_activity",
        eventType: "tool.result",
        normalizedKind: "command_output",
      },
    ],
    [
      "process/exited",
      {
        transport: "server-notification",
        family: "tool_activity",
        eventType: "tool.result",
        normalizedKind: "codex_exec_result",
      },
    ],
    // `turn/diff/updated` and `turn/plan/updated`: wire names from the pinned binary's generated
    // schema at codex-cli 0.150.1.
    [
      "turn/diff/updated",
      {
        transport: "server-notification",
        family: "tool_activity",
        eventType: "tool.result",
        normalizedKind: "diff",
      },
    ],
    [
      "turn/plan/updated",
      {
        transport: "server-notification",
        family: "assistant_output",
        eventType: "assistant.message",
        normalizedKind: "proposed_plan",
      },
    ],
  ]);

/** The methods the pinned census resolves to a reasoned NON-emission. */
const EXPECTED_NOT_EVENTED_METHODS: readonly CodexInboundFrameMethod[] = [
  "attestation/generate",
  "account/chatgptAuthTokens/refresh",
  "thread/reverted",
  "thread/queue/changed",
  "project/changed",
  "thread/project/updated",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/settings/updated",
  // Empty-payload skill-file watch cue: its only effect is daemon-side (the held command list is
  // discarded and re-read), so no timeline row holds it.
  "skills/changed",
  // The review's start and the moderation hint go to the daemon's log only.
  "item/autoApprovalReview/started",
  "turn/moderationMetadata",
  // The safety hold is relayed live on the run's state stream, never as a session row.
  "model/safetyBuffering/updated",
];

/** The six normalized event families every driver must be able to produce. */
const REQUIRED_NORMALIZED_FAMILIES: readonly EventCategory[] = [
  "run_lifecycle",
  "assistant_output",
  "tool_activity",
  "interactive_request",
  "artifact_publication",
  "usage_telemetry",
];

/**
 * The eleven realtime notifications deliberately absent from the census. The `realtime_*` family
 * has no V1 emitter, so mapping any of them would fabricate a family.
 *
 * All eleven are listed: the last three arrived beside the older spellings, not in place of them.
 */
const EXCLUDED_REALTIME_METHODS: readonly string[] = [
  "thread/realtime/started",
  "thread/realtime/closed",
  "thread/realtime/error",
  "thread/realtime/itemAdded",
  "thread/realtime/sdp",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/item/started",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/item/completed",
];

/**
 * The one non-realtime notification the `0.150.1` pin added. It is experimental-gated and has no
 * normalized family, so it is absent from the census and reaches the unknown-frame diagnostic.
 * Asserted explicitly because the gate cross-check filters to census members and would skip it.
 */
const EXCLUDED_NON_REALTIME_GATED_METHOD_AT_PIN = "mcpServer/event/stream/notification";

function normalizedRowsOfCensus(): readonly CodexNormalizedFamilyEmission[] {
  return CODEX_INBOUND_FRAME_METHODS.map((method) => normalizeCodexInboundFrame(method)).filter(
    (normalization): normalization is CodexNormalizedFamilyEmission =>
      normalization.disposition === "normalized",
  );
}

describe("Codex event normalizer — fixture census integrity", () => {
  it("carries all ten pinned ServerRequest methods", () => {
    expect(CODEX_SERVER_REQUEST_METHOD_VECTORS).toHaveLength(
      CODEX_SERVER_REQUEST_METHOD_COUNT_AT_PIN,
    );
    const methods = CODEX_SERVER_REQUEST_METHOD_VECTORS.map((vector) => vector.method);
    expect(new Set(methods).size).toBe(CODEX_SERVER_REQUEST_METHOD_COUNT_AT_PIN);
  });

  it("carries exactly the twenty-three experimental-gated notifications the pin enumerates", () => {
    const gated = CODEX_SERVER_NOTIFICATION_METHOD_VECTORS.filter(
      (vector) => vector.experimentalGatedAtPin,
    );
    expect(gated).toHaveLength(CODEX_GATED_SERVER_NOTIFICATION_COUNT_AT_PIN);
    // All eleven realtime names and the pin's one non-realtime addition are inside the
    // twenty-three.
    for (const realtimeMethod of EXCLUDED_REALTIME_METHODS) {
      expect(gated.map((vector) => vector.method)).toContain(realtimeMethod);
    }
    expect(gated.map((vector) => vector.method)).toContain(
      EXCLUDED_NON_REALTIME_GATED_METHOD_AT_PIN,
    );
  });

  it("is honest about being a strict subset of the 79-arm notification root", () => {
    // The fixture is a strict subset of the notification root, not a completeness claim.
    expect(CODEX_SERVER_NOTIFICATION_METHOD_VECTORS.length).toBeLessThan(
      CODEX_SERVER_NOTIFICATION_COUNT_AT_PIN,
    );
  });

  it("carries the two schema-absent variants as negative controls", () => {
    const absent = CODEX_SERVER_NOTIFICATION_METHOD_VECTORS.filter(
      (vector) => !vector.presentInPinnedGeneratedSchema,
    ).map((vector) => vector.method);
    expect(absent).toStrictEqual(["rawResponse/completed", "rawResponseItem/completed"]);
  });
});

describe("Codex event normalizer — every fixture frame normalizes as expected", () => {
  it.each(CODEX_SERVER_REQUEST_METHOD_VECTORS.map((vector) => vector.method))(
    "resolves ServerRequest %s",
    (method) => {
      const normalization = normalizeCodexInboundFrame(method);
      expect(normalization.transport).toBe("server-request");

      const expected = EXPECTED_NORMALIZED_ROWS.get(method as CodexInboundFrameMethod);
      if (expected === undefined) {
        // Only the two control-plane ServerRequests have no family emission; anything else is
        // drift.
        expect(EXPECTED_NOT_EVENTED_METHODS).toContain(method);
        expect(normalization.disposition).toBe("not-evented");
        return;
      }
      expect(normalization).toMatchObject({
        disposition: "normalized",
        nativeMethod: method,
        transport: expected.transport,
        family: expected.family,
        eventType: expected.eventType,
        normalizedKind: expected.normalizedKind,
      });
    },
  );

  it.each(
    // The exclusions are named, not derived from union membership: any other method missing from
    // the union still throws in `normalizeCodexInboundFrame`, which is the drift signal here.
    CODEX_SERVER_NOTIFICATION_METHOD_VECTORS.filter(
      (vector) =>
        vector.presentInPinnedGeneratedSchema &&
        !EXCLUDED_REALTIME_METHODS.includes(vector.method) &&
        vector.method !== EXCLUDED_NON_REALTIME_GATED_METHOD_AT_PIN,
    ).map((vector) => vector.method),
  )("resolves ServerNotification %s", (method) => {
    const normalization = normalizeCodexInboundFrame(method);
    expect(normalization.transport).toBe("server-notification");

    const expected = EXPECTED_NORMALIZED_ROWS.get(method as CodexInboundFrameMethod);
    if (expected === undefined) {
      expect(EXPECTED_NOT_EVENTED_METHODS).toContain(method);
      expect(normalization.disposition).toBe("not-evented");
      return;
    }
    expect(normalization).toMatchObject({
      disposition: "normalized",
      nativeMethod: method,
      transport: expected.transport,
      family: expected.family,
      eventType: expected.eventType,
      normalizedKind: expected.normalizedKind,
    });
  });

  it("normalizes the two corpus-described delta frames through typed constructors", () => {
    // The annotation binds each literal to `CodexInboundFrameMethod` at compile time, so dropping a
    // member from the union fails the build rather than a run-time string lookup.
    const diffFrame: CodexInboundFrameMethod = "turn/diff/updated";
    const planFrame: CodexInboundFrameMethod = "turn/plan/updated";

    expect(normalizeCodexInboundFrame(diffFrame)).toMatchObject({
      disposition: "normalized",
      family: "tool_activity",
      eventType: "tool.result",
      normalizedKind: "diff",
    });
    expect(normalizeCodexInboundFrame(planFrame)).toMatchObject({
      disposition: "normalized",
      family: "assistant_output",
      eventType: "assistant.message",
      normalizedKind: "proposed_plan",
    });
  });

  it("covers every census method with an independent expectation", () => {
    const expected = new Set<string>([
      ...EXPECTED_NORMALIZED_ROWS.keys(),
      ...EXPECTED_NOT_EVENTED_METHODS,
    ]);
    expect([...expected].sort()).toStrictEqual([...CODEX_INBOUND_FRAME_METHODS].sort());
  });
});

describe("Codex event normalizer — normalized-family coverage", () => {
  it("reaches five of the six required families from the pinned Codex census", () => {
    const reached = new Set(normalizedRowsOfCensus().map((row) => row.family));
    const reachedRequired = REQUIRED_NORMALIZED_FAMILIES.filter((family) => reached.has(family));
    expect(reachedRequired).toStrictEqual([
      "run_lifecycle",
      "assistant_output",
      "tool_activity",
      "interactive_request",
      "usage_telemetry",
    ]);
  });

  it("pins artifact_publication as reachable from NO Codex frame, and why", () => {
    // A corpus fact, asserted so it stays loud: `EVENT_DISPOSITION_BY_KIND` never names
    // `artifact_publication` as a target, `turn/diff/updated` routes to `tool_activity` as `diff`,
    // and the family is emitted daemon-side, not by a driver. A Codex mapping to it would assert
    // an emitter the design gives to another component.
    const reached = new Set(normalizedRowsOfCensus().map((row) => row.family));
    expect(reached.has("artifact_publication")).toBe(false);

    const dispositionCategories = new Set(
      [...EVENT_DISPOSITION_BY_KIND.values()]
        .map((entry) => entry.category)
        .filter((category): category is EventCategory => category !== undefined),
    );
    expect(dispositionCategories.has("artifact_publication")).toBe(false);
  });

  it("reaches only families taxonomy recognizes", () => {
    for (const row of normalizedRowsOfCensus()) {
      // A family is legitimate when the registry places the row's event type in it.
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(row.eventType)).toBe(row.family);
    }
  });
});

describe("Codex event normalizer — agreement with the contracts registries", () => {
  it("names a registered SessionEventType on every family emission", () => {
    for (const row of normalizedRowsOfCensus()) {
      expect(SESSION_EVENT_CATEGORY_BY_TYPE.has(row.eventType)).toBe(true);
    }
  });

  it("agrees with EVENT_DISPOSITION_BY_KIND on every row that names a census kind", () => {
    // Cross-checked here so a family that contradicts its census kind's category fails now, not at
    // integration.
    for (const row of normalizedRowsOfCensus()) {
      if (row.normalizedKind === null) {
        continue;
      }
      const entry = EVENT_DISPOSITION_BY_KIND.get(row.normalizedKind);
      expect(entry, `no disposition registered for kind ${row.normalizedKind}`).toBeDefined();
      if (entry === undefined) {
        return;
      }
      if (entry.disposition === "adopt" || entry.disposition === "rename") {
        // Category equality only: the registry's `eventType` is the row's primary target, and the
        // normalizer may fan out by outcome.
        expect(entry.category, `family drift on kind ${row.normalizedKind}`).toBe(row.family);
      } else {
        // A correlate or discard kind has no taxonomy target, so a family emission on it is
        // invented.
        expect.unreachable(
          `census kind ${row.normalizedKind} is ${entry.disposition}; it cannot back a family emission`,
        );
      }
    }
  });

  it("gives every not-evented row a stated, non-empty reason and no taxonomy target", () => {
    for (const method of EXPECTED_NOT_EVENTED_METHODS) {
      const normalization = normalizeCodexInboundFrame(method);
      expect(normalization.disposition).toBe("not-evented");
      if (normalization.disposition !== "not-evented") {
        return;
      }
      expect(normalization.reason.trim().length).toBeGreaterThan(0);
      expect(normalization.family).toBeUndefined();
      expect(normalization.eventType).toBeUndefined();
      expect(normalization.normalizedKind).toBeUndefined();
    }
  });
});

describe("Codex event normalizer — unknown-frame behavior is a typed refusal", () => {
  it("throws UnknownCodexInboundFrameError carrying the verbatim method", () => {
    expect(() => normalizeCodexInboundFrame("thread/notAMethod")).toThrow(
      UnknownCodexInboundFrameError,
    );
    try {
      normalizeCodexInboundFrame("thread/notAMethod");
      expect.unreachable("an unmapped method must refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownCodexInboundFrameError);
      expect((error as UnknownCodexInboundFrameError).nativeMethod).toBe("thread/notAMethod");
    }
  });

  it("refuses rather than silently dropping (never returns undefined)", () => {
    // An unmapped frame must be observable: the bare resolver throws, and the routing entry point
    // turns that into a diagnostic record.
    let returned: CodexFrameNormalization | undefined;
    try {
      returned = normalizeCodexInboundFrame("codex/unheard-of");
    } catch {
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });

  it("refuses prototype-chain keys instead of resolving them", () => {
    // The lookup is a ReadonlyMap because an object literal would resolve these names to truthy
    // non-normalization values.
    for (const hostileMethod of [
      "__proto__",
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
    ]) {
      expect(() => normalizeCodexInboundFrame(hostileMethod)).toThrow(
        UnknownCodexInboundFrameError,
      );
    }
  });

  it("refuses all eight excluded realtime notifications (routing pin)", () => {
    for (const realtimeMethod of EXCLUDED_REALTIME_METHODS) {
      expect(() => normalizeCodexInboundFrame(realtimeMethod)).toThrow(
        UnknownCodexInboundFrameError,
      );
    }
  });

  it("refuses the two variants the pinned generation does not emit", () => {
    for (const absentMethod of ["rawResponse/completed", "rawResponseItem/completed"]) {
      expect(() => normalizeCodexInboundFrame(absentMethod)).toThrow(UnknownCodexInboundFrameError);
    }
  });
});

describe("Codex event normalizer — purity and determinism", () => {
  it("returns an identical, identity-stable result for the same frame twice", () => {
    for (const method of CODEX_INBOUND_FRAME_METHODS) {
      const first = normalizeCodexInboundFrame(method);
      const second = normalizeCodexInboundFrame(method);
      expect(second).toStrictEqual(first);
      // Identity, not just deep equality: the resolver hands out shared frozen entries, so
      // per-call allocation would fail here.
      expect(second).toBe(first);
    }
  });

  it("hands out frozen entries no consumer can corrupt process-wide", () => {
    const normalization = normalizeCodexInboundFrame("error");
    expect(Object.isFrozen(normalization)).toBe(true);
    expect(() => {
      (normalization as { family: EventCategory }).family = "usage_telemetry";
    }).toThrow(TypeError);
    expect(normalizeCodexInboundFrame("error").family).toBe("run_lifecycle");
  });

  it("keeps the exported census tuple and the lookup map set-equal both ways", () => {
    const tupleMethods = [...CODEX_INBOUND_FRAME_METHODS].sort();
    const mapMethods = [...CODEX_FRAME_NORMALIZATION_BY_METHOD.keys()].sort();
    expect(tupleMethods).toStrictEqual(mapMethods);
    expect(new Set(tupleMethods).size).toBe(tupleMethods.length);
  });

  it("stamps every entry with its own method, so a row cannot be mis-keyed", () => {
    for (const [method, normalization] of CODEX_FRAME_NORMALIZATION_BY_METHOD) {
      expect(normalization.nativeMethod).toBe(method);
    }
  });
});

// Emission readiness is derived, not stated.
//
// The stamp says whether a row's `SessionEventType` can be built into a `SessionEvent` envelope
// now. It is derived at map-build from the live `SESSION_EVENT_TYPES` roster, so it widens when a
// payload variant is registered. It is not folded into `EXPECTED_NORMALIZED_ROWS`: restating
// `payload-variant-pending` on each hand-written row would hard-code what the derivation removes.
// The stamp is checked against the resolver, and the resolver against contracts.
//
// Hard-coding a stamp on a record row does not compile (the row type omits the key), and a wrong
// value at the derivation site fails two tests below. Any single value hard-coded there disagrees
// with the resolver on some row, because the census mixes registered and unregistered targets.

describe("Codex event normalizer — emission readiness is derived, not stated", () => {
  it("resolves a registered payload-variant target as envelope-constructible", () => {
    // Called directly with a non-Codex literal so this arm stays provable however the census moves.
    expect(SESSION_EVENT_TYPES).toContain("session.created");
    expect(resolveCodexEmissionReadiness("session.created")).toBe("envelope-constructible");
  });

  it("resolves an unregistered target as payload-variant-pending", () => {
    // `run.failed` is a Codex target with no registered payload variant.
    expect(SESSION_EVENT_TYPES).not.toContain("run.failed");
    expect(resolveCodexEmissionReadiness("run.failed")).toBe("payload-variant-pending");
  });

  it("agrees with the live contracts roster for every registered type", () => {
    for (const registeredType of SESSION_EVENT_TYPES) {
      expect(resolveCodexEmissionReadiness(registeredType)).toBe("envelope-constructible");
    }
  });

  it("stamps every normalized census row with the resolver's own answer", () => {
    // A stamp that disagrees with the live roster fails; a widened roster follows automatically.
    for (const [nativeMethod, normalization] of CODEX_FRAME_NORMALIZATION_BY_METHOD) {
      if (normalization.disposition !== "normalized") {
        continue;
      }
      expect(
        normalization.emissionReadiness,
        `${nativeMethod} carries a stamp that disagrees with the live roster`,
      ).toBe(resolveCodexEmissionReadiness(normalization.eventType));
    }
  });

  it("stamps every normalized row with a member of the readiness union", () => {
    const admissibleAnswers = new Set(["envelope-constructible", "payload-variant-pending"]);
    for (const normalization of CODEX_FRAME_NORMALIZATION_BY_METHOD.values()) {
      if (normalization.disposition !== "normalized") {
        continue;
      }
      expect(admissibleAnswers).toContain(normalization.emissionReadiness);
    }
  });

  it("leaves not-evented rows unstamped — they name no target to be ready for", () => {
    for (const [nativeMethod, normalization] of CODEX_FRAME_NORMALIZATION_BY_METHOD) {
      if (normalization.disposition !== "not-evented") {
        continue;
      }
      expect(
        Object.prototype.hasOwnProperty.call(normalization, "emissionReadiness"),
        `${nativeMethod} is not-evented and must carry no readiness stamp`,
      ).toBe(false);
    }
  });

  it("keeps the stamp identity-stable across repeated resolution", () => {
    const first = normalizeCodexInboundFrame("error");
    const second = normalizeCodexInboundFrame("error");
    expect(first).toBe(second);
    expect(first.disposition).toBe("normalized");
    expect((first as CodexNormalizedFamilyEmission).emissionReadiness).toBe(
      (second as CodexNormalizedFamilyEmission).emissionReadiness,
    );
  });
});

// Tool-identity binding. The production binding is the type annotation on
// `CODEX_TOOL_KEYED_APPROVAL_METHODS`, so a `tools.ts` namespace rename is a compile error. These
// tests assert the runtime half: the bound methods are census keys and their embedded segments
// are `CODEX_TOOL_NAMES` members.

describe("Codex event normalizer — tool-keyed methods bind to the tools.ts namespace", () => {
  it("binds every tool-keyed approval method to a live CodexToolName", () => {
    for (const approvalMethod of CODEX_TOOL_KEYED_APPROVAL_METHODS) {
      const embeddedToolName = approvalMethod.slice(
        "item/".length,
        approvalMethod.length - "/requestApproval".length,
      );
      expect(
        CODEX_TOOL_NAMES,
        `${approvalMethod} embeds a segment that is not a CodexToolName`,
      ).toContain(embeddedToolName);
    }
  });

  it("keeps every tool-keyed approval method in the normalization census", () => {
    // A tool namespace change could silently drop the method from the census, sending approval
    // frames to the unknown-frame diagnostic instead of approval_flow.
    for (const approvalMethod of CODEX_TOOL_KEYED_APPROVAL_METHODS) {
      expect(CODEX_INBOUND_FRAME_METHODS).toContain(approvalMethod);
      expect(CODEX_FRAME_NORMALIZATION_BY_METHOD.has(approvalMethod)).toBe(true);
    }
  });

  it("normalizes every tool-keyed approval method into approval.requested", () => {
    for (const approvalMethod of CODEX_TOOL_KEYED_APPROVAL_METHODS) {
      expect(normalizeCodexInboundFrame(approvalMethod)).toMatchObject({
        disposition: "normalized",
        transport: "server-request",
        family: "approval_flow",
        eventType: "approval.requested",
      });
    }
  });

  it("covers exactly the two mutating tools that gate on approval at the pin", () => {
    // Pinned at two, not total over `CODEX_TOOL_NAMES`: the pinned wire census shows no approval
    // method for the other tools (for example `item/webSearch/requestApproval`).
    expect([...CODEX_TOOL_KEYED_APPROVAL_METHODS].sort()).toEqual([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ]);
  });

  it("freezes the bound-method census against consumer mutation", () => {
    expect(Object.isFrozen(CODEX_TOOL_KEYED_APPROVAL_METHODS)).toBe(true);
  });
});

// Negotiation-gated methods. The driver ships `experimentalApi: false`, so every census member the
// pin marks experimental is unreachable today. The production module declares that set because
// neither the generated schema (for notifications) nor `tools.ts` encodes the gate; these tests
// pin it to the `__fixtures__/` gate tags across both transports.

describe("Codex event normalizer — negotiation-gated methods are declared, not assumed", () => {
  /** Census members the fixtures tag experimental-gated, on either transport. */
  const fixtureGatedCensusMethods = (): readonly string[] => {
    const censusMethods = new Set<string>(CODEX_INBOUND_FRAME_METHODS);
    return [
      ...CODEX_SERVER_REQUEST_METHOD_VECTORS.filter((vector) => vector.experimentalGatedAtPin).map(
        (vector) => vector.method,
      ),
      ...CODEX_SERVER_NOTIFICATION_METHOD_VECTORS.filter(
        (vector) => vector.experimentalGatedAtPin,
      ).map((vector) => vector.method),
    ].filter((method) => censusMethods.has(method));
  };

  it("declares exactly the census members the fixtures tag gated", () => {
    // Set equality both ways: a gated census method left undeclared fails, and so does a
    // declaration naming a method the fixtures do not tag.
    expect([...CODEX_NEGOTIATION_GATED_METHODS].sort()).toEqual(
      [...fixtureGatedCensusMethods()].sort(),
    );
  });

  it("covers both transports — the gate is not a notification-only concern", () => {
    // The gate is not notification-only: `item/tool/requestUserInput` is a request and the one
    // experimental-marked arm of the pinned binary's ten.
    const gatedTransports = new Set(
      CODEX_NEGOTIATION_GATED_METHODS.map((method) => {
        const normalization = CODEX_FRAME_NORMALIZATION_BY_METHOD.get(method);
        expect(
          normalization,
          `${method} is declared gated but absent from the census`,
        ).toBeDefined();
        return normalization?.transport;
      }),
    );
    expect(gatedTransports).toEqual(new Set(["server-request", "server-notification"]));
    expect(CODEX_NEGOTIATION_GATED_METHODS).toContain("item/tool/requestUserInput");
  });

  it("keeps every declared gated method mapped rather than deleted", () => {
    // The rows stay mapped so a posture flip or pin bump inherits their dispositions instead of
    // routing twelve settled frames to diagnostic at once.
    for (const gatedMethod of CODEX_NEGOTIATION_GATED_METHODS) {
      expect(CODEX_INBOUND_FRAME_METHODS).toContain(gatedMethod);
      expect(() => normalizeCodexInboundFrame(gatedMethod)).not.toThrow();
    }
  });

  it("excludes the realtime methods, which are suppressed rather than dormant", () => {
    // Realtime frames are suppressed by name at the source and target a family with no V1 emitter,
    // so they are not in the census; gated frames have settled dispositions and only await
    // delivery.
    for (const realtimeMethod of EXCLUDED_REALTIME_METHODS) {
      expect(CODEX_NEGOTIATION_GATED_METHODS).not.toContain(realtimeMethod);
      expect(CODEX_INBOUND_FRAME_METHODS).not.toContain(realtimeMethod);
    }
  });

  it("excludes the pin's non-realtime gated addition, which is unmapped rather than dormant", () => {
    // `mcpServer/event/stream/notification` is gated but neither suppressed by name nor given a
    // family, so it belongs in neither the union nor the gated declaration: it must reach the
    // unknown-frame diagnostic. Nothing else checks its fixture gate tag, since the cross-check
    // above filters to census members.
    expect(CODEX_INBOUND_FRAME_METHODS).not.toContain(EXCLUDED_NON_REALTIME_GATED_METHOD_AT_PIN);
    expect(CODEX_NEGOTIATION_GATED_METHODS).not.toContain(
      EXCLUDED_NON_REALTIME_GATED_METHOD_AT_PIN,
    );
    expect(() => normalizeCodexInboundFrame(EXCLUDED_NON_REALTIME_GATED_METHOD_AT_PIN)).toThrow(
      UnknownCodexInboundFrameError,
    );
  });

  it("leaves the ungated remainder of the census reachable at the shipped posture", () => {
    // Non-vacuity: an empty set would make the suite above assert nothing.
    const reachable = CODEX_INBOUND_FRAME_METHODS.filter(
      (method) => !CODEX_NEGOTIATION_GATED_METHODS.includes(method),
    );
    expect(reachable.length).toBeGreaterThan(0);
    expect(reachable.length + CODEX_NEGOTIATION_GATED_METHODS.length).toBe(
      CODEX_INBOUND_FRAME_METHODS.length,
    );
  });

  it("freezes the declaration against consumer mutation", () => {
    expect(Object.isFrozen(CODEX_NEGOTIATION_GATED_METHODS)).toBe(true);
  });

  it("pins the transport split the declaration comment states", () => {
    // The comment on `CODEX_NEGOTIATION_GATED_METHODS` states "1 of 10" requests and "11 of 26"
    // notifications; a prose count that no test reads drifts, so the split is pinned here.
    const rows = [...CODEX_FRAME_NORMALIZATION_BY_METHOD.values()];
    expect(rows.filter((row) => row.transport === "server-request")).toHaveLength(10);
    expect(rows.filter((row) => row.transport === "server-notification")).toHaveLength(26);

    const gatedByTransport = CODEX_NEGOTIATION_GATED_METHODS.map(
      (method) => CODEX_FRAME_NORMALIZATION_BY_METHOD.get(method)?.transport,
    );
    expect(gatedByTransport.filter((transport) => transport === "server-request")).toHaveLength(1);
    expect(
      gatedByTransport.filter((transport) => transport === "server-notification"),
    ).toHaveLength(11);
  });
});

describe("Codex event normalizer — the truncated delta names stay off the census", () => {
  it("refuses the truncated wire names delta row once carried", () => {
    // The bare forms `turn/diff` and `turn/plan` appear nowhere in the pinned binary's generated
    // `ServerNotification` schema (codex-cli 0.150.1); the real names are `turn/diff/updated` and
    // `turn/plan/updated`. The bare forms are the intuitive spellings, so restoring either must
    // fail here instead of silently routing real frames to the unknown-frame diagnostic.
    for (const truncatedName of ["turn/diff", "turn/plan"]) {
      expect(CODEX_INBOUND_FRAME_METHODS).not.toContain(truncatedName);
      expect(() => normalizeCodexInboundFrame(truncatedName)).toThrow(
        UnknownCodexInboundFrameError,
      );
    }
  });

  it("maps the generator-verified names, and only those", () => {
    for (const generatedName of ["turn/diff/updated", "turn/plan/updated"]) {
      expect(CODEX_INBOUND_FRAME_METHODS).toContain(generatedName);
      expect(normalizeCodexInboundFrame(generatedName)).toMatchObject({
        disposition: "normalized",
        transport: "server-notification",
      });
    }
  });

  it("keeps turn/moderationMetadata bare — only two of the three were wrong", () => {
    // The pinned binary emits this one unsuffixed; renaming it for consistency with its siblings
    // would break a correct name.
    expect(CODEX_INBOUND_FRAME_METHODS).toContain("turn/moderationMetadata");
    expect(CODEX_INBOUND_FRAME_METHODS).not.toContain("turn/moderationMetadata/updated");
  });
});

describe("resolveCodexFrameEmissionRoute", () => {
  function makeDiagnostics() {
    return new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } });
  }

  it("mirrors the mapping table's verdict for every censused method — the route arm IS the row's disposition", () => {
    const diagnostics = makeDiagnostics();
    for (const method of CODEX_INBOUND_FRAME_METHODS) {
      const row = CODEX_FRAME_NORMALIZATION_BY_METHOD.get(method);
      const route = resolveCodexFrameEmissionRoute(method, diagnostics);
      if (row?.disposition === "not-evented") {
        expect(route.route, method).toBe("not-evented");
      } else if (row?.emissionReadiness === "payload-variant-pending") {
        expect(route.route, method).toBe("diagnostic");
        if (route.route === "diagnostic") {
          expect(route.record.kind, method).toBe("payload_variant_pending");
        }
      } else {
        expect(route.route, method).toBe("emit");
      }
    }
    // A censused method never lands on the unmapped arm.
    expect(diagnostics.recentRecordsOfKind("unmapped_wire_kind")).toHaveLength(0);
  });

  it("routes an unmapped method to the diagnostic default branch — emitted, never thrown, never enveloped", () => {
    const diagnostics = makeDiagnostics();
    const route = resolveCodexFrameEmissionRoute("thread/unheard-of", diagnostics);
    expect(route.route).toBe("diagnostic");
    if (route.route === "diagnostic") {
      expect(route.record.kind).toBe("unmapped_wire_kind");
      expect(route.record.rawWireType).toBe("thread/unheard-of");
      expect(route.record.provider).toBe("codex");
    }
    expect(diagnostics.emittedRecordCount()).toBe(1);
    // The bare resolver still throws for direct misuse; the diagnostic route is the driver entry.
    expect(() => normalizeCodexInboundFrame("thread/unheard-of")).toThrow(
      UnknownCodexInboundFrameError,
    );
  });
});

describe("classifyCodexFrameFamilyForRouting", () => {
  it("classifies every censused method plus the two router-band methods — none falls to unknown", () => {
    const routableMethods = [
      ...CODEX_INBOUND_FRAME_METHODS,
      CODEX_THREAD_STARTED_METHOD,
      CODEX_THREAD_TOKEN_USAGE_METHOD,
    ];
    for (const method of routableMethods) {
      expect(classifyCodexFrameFamilyForRouting(method).scope, method).not.toBe("unknown");
    }
  });

  it("classifies the account-plane and notice families connection-scoped", () => {
    for (const connectionScopedMethod of [
      "error",
      "account/rateLimits/updated",
      "account/chatgptAuthTokens/refresh",
      "project/changed",
      // Its payload is the empty object, so it names no thread; an unlisted method quarantines,
      // which would emit a router diagnostic on every skill-file save.
      "skills/changed",
    ]) {
      expect(classifyCodexFrameFamilyForRouting(connectionScopedMethod)).toEqual({
        scope: "connection",
      });
    }
  });

  it("classifies the usage reading and the compaction marker thread-scoped usage", () => {
    expect(classifyCodexFrameFamilyForRouting(CODEX_THREAD_TOKEN_USAGE_METHOD)).toEqual({
      scope: "thread",
      capability: "usage",
    });
    expect(classifyCodexFrameFamilyForRouting("thread/compacted")).toEqual({
      scope: "thread",
      capability: "usage",
    });
  });

  it("classifies thread/started and the safety hold lifecycle and the approval asks interactive-request", () => {
    // The safety hold names its thread and turn, so a child's hold stays with the child, not the
    // lead's working line.
    for (const lifecycleMethod of [CODEX_THREAD_STARTED_METHOD, "model/safetyBuffering/updated"]) {
      expect(classifyCodexFrameFamilyForRouting(lifecycleMethod)).toEqual({
        scope: "thread",
        capability: "lifecycle",
      });
    }
    for (const interactiveMethod of [
      "item/commandExecution/requestApproval",
      "item/tool/requestUserInput",
      "execCommandApproval",
    ]) {
      expect(classifyCodexFrameFamilyForRouting(interactiveMethod)).toEqual({
        scope: "thread",
        capability: "interactive-request",
      });
    }
  });

  it("classifies an unlisted shape unknown — the realtime family and novel methods are never presumed connection-scoped", () => {
    for (const unlistedMethod of ["realtime/audioDelta", "novel/unheard-of"]) {
      expect(classifyCodexFrameFamilyForRouting(unlistedMethod)).toEqual({ scope: "unknown" });
    }
  });
});

describe("deriveCodexChildThreadAnnouncement", () => {
  it("marks the subagent-attributed ThreadSourceKind arms with the child thread id as subagent identity", () => {
    for (const threadSourceKind of CODEX_SUBAGENT_ATTRIBUTED_THREAD_SOURCE_KINDS) {
      expect(
        deriveCodexChildThreadAnnouncement({
          threadId: "child-thread",
          parentThreadId: "parent-thread",
          threadSourceKind,
        }),
      ).toEqual({
        childThreadId: "child-thread",
        declaredParentThreadId: "parent-thread",
        subagentId: "child-thread",
      });
    }
  });

  it("marks a compaction child provider-internal — spend attributes to the parent run", () => {
    expect(
      deriveCodexChildThreadAnnouncement({
        threadId: "compaction-thread",
        parentThreadId: "parent-thread",
        threadSourceKind: "subAgentCompact",
      }),
    ).toEqual({
      childThreadId: "compaction-thread",
      declaredParentThreadId: "parent-thread",
      subagentId: null,
    });
  });

  it("carries an absent parent linkage verbatim — the router, not this helper, refuses it", () => {
    expect(
      deriveCodexChildThreadAnnouncement({
        threadId: "child-thread",
        parentThreadId: null,
        threadSourceKind: "subAgent",
      }).declaredParentThreadId,
    ).toBeNull();
  });
});

// The terminal-emission boundary. A daemon-initiated close is stamped `intendedClose` so recovery
// reads a clean shutdown as clean rather than as a crash, and the ordinary post-interrupt double
// terminal for one `(runId, runVersion)` epoch is absorbed at the driver rather than failing
// against the partial unique index on terminal session events.

describe("CodexTerminalEmissionGate", () => {
  const PROJECTED_ROUTE = { decision: "project" } as const;

  function terminalFrame(overrides: Partial<CodexTerminalRunFrame> = {}): CodexTerminalRunFrame {
    return {
      runId: "run-1",
      runVersion: 1,
      rawWireType: "turn/completed",
      route: PROJECTED_ROUTE,
      ...overrides,
    };
  }

  it("stamps `intendedClose: false` for a terminal no close preceded", () => {
    const gate = new CodexTerminalEmissionGate();

    expect(gate.admitTerminalFrame(terminalFrame())).toStrictEqual({
      emit: true,
      runId: "run-1",
      runVersion: 1,
      intendedClose: false,
    });
  });

  it("stamps `intendedClose: true` once a daemon-initiated close is signaled", () => {
    const gate = new CodexTerminalEmissionGate();

    gate.signalIntendedClose();

    expect(gate.intendedCloseSignaled()).toBe(true);
    expect(gate.admitTerminalFrame(terminalFrame())).toMatchObject({
      emit: true,
      intendedClose: true,
    });
  });

  it("suppresses a second terminal for the SAME epoch", () => {
    // The ordinary post-interrupt double, absorbed here rather than failing against the schema
    // backstop.
    const gate = new CodexTerminalEmissionGate();
    gate.admitTerminalFrame(terminalFrame());

    expect(gate.admitTerminalFrame(terminalFrame({ rawWireType: "turn/failed" }))).toStrictEqual({
      emit: false,
      suppressionReason: "duplicate-terminal-epoch",
    });
    expect(gate.hasSettledEpoch("run-1", 1)).toBe(true);
  });

  it("admits a NEW epoch for the same run", () => {
    // The key is the epoch, not the run: a re-dispatched run version is a separate settlement.
    const gate = new CodexTerminalEmissionGate();
    gate.admitTerminalFrame(terminalFrame());

    expect(gate.admitTerminalFrame(terminalFrame({ runVersion: 2 }))).toMatchObject({ emit: true });
    expect(gate.hasSettledEpoch("run-1", 2)).toBe(true);
  });

  it("settles no run for a frame the router did not route to the session's thread", () => {
    // Routing is consumed, not re-decided: a child thread's terminal must not settle the parent's
    // run.
    const gate = new CodexTerminalEmissionGate();

    const decision = gate.admitTerminalFrame(
      terminalFrame({ route: { decision: "suppress-child-transcript", childThreadId: "child-1" } }),
    );

    expect(decision).toStrictEqual({ emit: false, suppressionReason: "not-the-session-thread" });
    // It consumed no epoch, so the parent's own terminal still settles.
    expect(gate.hasSettledEpoch("run-1", 1)).toBe(false);
  });

  it("evicts oldest-first so the memory stays proportional to the hazard", () => {
    // A long session's run count is unbounded; the window in which a duplicate arrives is not.
    const gate = new CodexTerminalEmissionGate({ settledEpochMemory: 2 });
    gate.admitTerminalFrame(terminalFrame({ runId: "run-a" }));
    gate.admitTerminalFrame(terminalFrame({ runId: "run-b" }));
    gate.admitTerminalFrame(terminalFrame({ runId: "run-c" }));

    expect(gate.hasSettledEpoch("run-a", 1)).toBe(false);
    expect(gate.hasSettledEpoch("run-b", 1)).toBe(true);
    expect(gate.hasSettledEpoch("run-c", 1)).toBe(true);
  });
});

// Typed provider usage-limit signal, Codex side. Snapshot shapes follow the pinned generated
// protocol: `RateLimitSnapshot` carries `rateLimitReachedType` and `primary` / `secondary`
// `RateLimitWindow`s (`usedPercent`, `windowDurationMins`, `resetsAt` in Unix seconds).

/** `2026-09-01T00:00:00.000Z`, as the provider states it. */
const SEPTEMBER_RESET_EPOCH_SECONDS = 1788220800;
/** Six hours later, so "latest wins" is distinguishable from "first wins". */
const LATER_RESET_EPOCH_SECONDS = SEPTEMBER_RESET_EPOCH_SECONDS + 21600;

function rateLimitsReadReply(snapshot: Record<string, unknown>): Record<string, unknown> {
  return { rateLimits: snapshot };
}

function rateLimitsUpdatedParams(snapshot: Record<string, unknown>): Record<string, unknown> {
  return { rateLimits: snapshot };
}

describe("classifyCodexUsageLimitSignal — typed-only recognition on the account plane", () => {
  it("names both account-plane carriers by identity rather than by a repeated literal", () => {
    expect(CODEX_ACCOUNT_RATE_LIMITS_READ_METHOD).toBe("account/rateLimits/read");
    expect(CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD).toBe("account/rateLimits/updated");
  });

  it("PARTITIONS the pinned reached-type enum into recognized and deliberately excluded", () => {
    // Every reached-type arm the pin publishes falls in exactly one set, so an arm added upstream
    // cannot slip into the unrecognized path.
    expect(CODEX_RATE_LIMIT_REACHED_TYPES).toHaveLength(5);
    const recognized = CODEX_RATE_LIMIT_REACHED_TYPES.filter(
      (reachedType) =>
        classifyCodexUsageLimitSignal({
          latestRead: rateLimitsReadReply({ rateLimitReachedType: reachedType }),
          rollingUpdate: null,
        }) !== null,
    );
    expect([...recognized].sort()).toEqual([
      "rate_limit_reached",
      "workspace_member_usage_limit_reached",
      "workspace_owner_usage_limit_reached",
    ]);
    expect([...CODEX_USAGE_LIMIT_EXCLUDED_REACHED_TYPES].sort()).toEqual([
      "workspace_member_credits_depleted",
      "workspace_owner_credits_depleted",
    ]);
    // A partition: the union is the census and the sets do not overlap.
    expect([...recognized, ...CODEX_USAGE_LIMIT_EXCLUDED_REACHED_TYPES].sort()).toEqual(
      [...CODEX_RATE_LIMIT_REACHED_TYPES].sort(),
    );
  });

  it("emits the signal with a PROVIDER-STATED boundary read from the spent window", () => {
    const signal = classifyCodexUsageLimitSignal({
      latestRead: rateLimitsReadReply({
        rateLimitReachedType: "rate_limit_reached",
        limitName: "Weekly limit",
        primary: {
          usedPercent: 100,
          windowDurationMins: 10080,
          resetsAt: SEPTEMBER_RESET_EPOCH_SECONDS,
        },
        secondary: {
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: LATER_RESET_EPOCH_SECONDS,
        },
      }),
      rollingUpdate: null,
    });

    expect(signal).toEqual({
      cause: "plan-allowance-exhausted",
      resetBoundary: { resetsAt: "2026-09-01T00:00:00.000Z", provenance: "provider-stated" },
    });
  });

  it("reads `resetsAt` as Unix SECONDS, not milliseconds", () => {
    // Read as milliseconds, the boundary would land decades early and look like an immediate
    // resume rather than a parse failure.
    const signal = classifyCodexUsageLimitSignal({
      latestRead: rateLimitsReadReply({
        rateLimitReachedType: "workspace_owner_usage_limit_reached",
        primary: { usedPercent: 100, resetsAt: SEPTEMBER_RESET_EPOCH_SECONDS },
      }),
      rollingUpdate: null,
    });
    expect(signal?.resetBoundary?.resetsAt).toBe("2026-09-01T00:00:00.000Z");
    expect(signal?.resetBoundary?.resetsAt).not.toBe(
      new Date(SEPTEMBER_RESET_EPOCH_SECONDS).toISOString(),
    );
  });

  it("takes the LATEST reset among the windows the provider marks spent", () => {
    // The earliest would schedule a resume the other window still refuses, turning one park into a
    // retry ladder.
    const signal = classifyCodexUsageLimitSignal({
      latestRead: rateLimitsReadReply({
        rateLimitReachedType: "workspace_member_usage_limit_reached",
        primary: { usedPercent: 100, resetsAt: SEPTEMBER_RESET_EPOCH_SECONDS },
        secondary: { usedPercent: 100, resetsAt: LATER_RESET_EPOCH_SECONDS },
      }),
      rollingUpdate: null,
    });
    expect(signal?.resetBoundary?.resetsAt).toBe(
      new Date(LATER_RESET_EPOCH_SECONDS * 1000).toISOString(),
    );
  });

  it("MERGES the sparse push frame over the last full read, per the vendor's own rule", () => {
    // The push frame is sparse and the vendor says to merge it into the latest read; a classifier
    // fed only the push would read an absent window as no boundary.
    const signal = classifyCodexUsageLimitSignal({
      latestRead: rateLimitsReadReply({
        rateLimitReachedType: null,
        primary: { usedPercent: 100, resetsAt: SEPTEMBER_RESET_EPOCH_SECONDS },
      }),
      rollingUpdate: rateLimitsUpdatedParams({ rateLimitReachedType: "rate_limit_reached" }),
    });
    expect(signal).toEqual({
      cause: "plan-allowance-exhausted",
      resetBoundary: { resetsAt: "2026-09-01T00:00:00.000Z", provenance: "provider-stated" },
    });
  });

  it("does not let a NULL member of a sparse update clear a previously observed value", () => {
    // The vendor states that nullable metadata in a rolling update "does not clear a previously
    // observed value".
    const signal = classifyCodexUsageLimitSignal({
      latestRead: rateLimitsReadReply({
        rateLimitReachedType: "rate_limit_reached",
        primary: { usedPercent: 100, resetsAt: SEPTEMBER_RESET_EPOCH_SECONDS },
      }),
      rollingUpdate: rateLimitsUpdatedParams({ rateLimitReachedType: null, primary: null }),
    });
    expect(signal?.cause).toBe("plan-allowance-exhausted");
    expect(signal?.resetBoundary?.resetsAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("returns the CAUSE ALONE when no window the provider marks spent names a reset", () => {
    // A missing boundary changes only whether a resume is scheduled, not whether the run is
    // limited.
    const signal = classifyCodexUsageLimitSignal({
      latestRead: rateLimitsReadReply({
        rateLimitReachedType: "rate_limit_reached",
        primary: { usedPercent: 100, resetsAt: null },
        secondary: { usedPercent: 12, resetsAt: LATER_RESET_EPOCH_SECONDS },
      }),
      rollingUpdate: null,
    });
    expect(signal).toEqual({ cause: "plan-allowance-exhausted" });
  });

  it("SEEDED DISCRIMINATING CONTROL — prose plus an exit code produce NO signal", () => {
    // Prose and exit codes a text-matching classifier would accept; none is the typed enum, so all
    // four must be silent.
    const proseAndExitCodeCarriers: readonly unknown[] = [
      { exitCode: 429, message: "You have exceeded your usage limit. Resets 2026-09-01." },
      { rateLimits: { limitName: "usage limit reached — try again after the weekly reset" } },
      {
        rateLimits: {
          limitId: "weekly",
          limitName: "Rate limit exceeded",
          planType: "pro",
          spendControlReached: true,
          primary: { usedPercent: 100, resetsAt: SEPTEMBER_RESET_EPOCH_SECONDS },
        },
      },
      { error: { code: -32000, message: "429 Too Many Requests: usage limit reached" } },
    ];

    for (const carrier of proseAndExitCodeCarriers) {
      expect(
        classifyCodexUsageLimitSignal({ latestRead: carrier, rollingUpdate: null }),
      ).toBeNull();
      expect(
        classifyCodexUsageLimitSignal({ latestRead: null, rollingUpdate: carrier }),
      ).toBeNull();
    }
  });

  it("does not let boundary SELECTION leak into recognition", () => {
    // Both windows fully consumed with reset instants but no reached-type arm: an account at its
    // ceiling is not a refused turn, so `usedPercent` only selects the boundary.
    expect(
      classifyCodexUsageLimitSignal({
        latestRead: rateLimitsReadReply({
          primary: { usedPercent: 100, resetsAt: SEPTEMBER_RESET_EPOCH_SECONDS },
          secondary: { usedPercent: 100, resetsAt: LATER_RESET_EPOCH_SECONDS },
        }),
        rollingUpdate: null,
      }),
    ).toBeNull();
  });

  it("stays silent on the OPERATOR-REMEDIABLE arms rather than parking a run", () => {
    // A depleted credit balance is restored by a purchase, not by a window turning over, so a
    // reset boundary would promise a change that never comes.
    for (const reachedType of CODEX_USAGE_LIMIT_EXCLUDED_REACHED_TYPES) {
      expect(
        classifyCodexUsageLimitSignal({
          latestRead: rateLimitsReadReply({
            rateLimitReachedType: reachedType,
            primary: { usedPercent: 100, resetsAt: SEPTEMBER_RESET_EPOCH_SECONDS },
          }),
          rollingUpdate: null,
        }),
      ).toBeNull();
    }
  });

  it("yields NOTHING — never a default-caused signal — on unparseable or absent input", () => {
    const unrecognized: readonly unknown[] = [
      null,
      undefined,
      "account/rateLimits/read",
      42,
      [],
      [{ rateLimits: { rateLimitReachedType: "rate_limit_reached" } }],
      {},
      { rateLimits: null },
      { rateLimits: "rate_limit_reached" },
      { rateLimits: { rateLimitReachedType: "quota_exhausted" } },
      { rateLimits: { rateLimitReachedType: 7 } },
      { rateLimits: { rateLimitReachedType: { kind: "rate_limit_reached" } } },
    ];
    for (const carrier of unrecognized) {
      expect(
        classifyCodexUsageLimitSignal({ latestRead: carrier, rollingUpdate: null }),
      ).toBeNull();
      expect(
        classifyCodexUsageLimitSignal({ latestRead: null, rollingUpdate: carrier }),
      ).toBeNull();
    }
    expect(classifyCodexUsageLimitSignal({ latestRead: null, rollingUpdate: null })).toBeNull();
  });

  it("refuses a reset instant that names no representable moment", () => {
    // A spent window whose `resetsAt` is not a representable instant still yields the cause.
    for (const resetsAt of [Number.NaN, Number.POSITIVE_INFINITY, 1e18, "soon", {}]) {
      expect(
        classifyCodexUsageLimitSignal({
          latestRead: rateLimitsReadReply({
            rateLimitReachedType: "rate_limit_reached",
            primary: { usedPercent: 100, resetsAt },
          }),
          rollingUpdate: null,
        }),
      ).toEqual({ cause: "plan-allowance-exhausted" });
    }
  });

  it("reads the consumed fraction TOLERANTLY across the pin's two numeric widths", () => {
    // `f64` in the core protocol type, `i32` in the app-server struct.
    for (const usedPercent of [100, 100.0, 100.5, 137]) {
      expect(
        classifyCodexUsageLimitSignal({
          latestRead: rateLimitsReadReply({
            rateLimitReachedType: "rate_limit_reached",
            primary: { usedPercent, resetsAt: SEPTEMBER_RESET_EPOCH_SECONDS },
          }),
          rollingUpdate: null,
        })?.resetBoundary?.resetsAt,
      ).toBe("2026-09-01T00:00:00.000Z");
    }
  });
});
