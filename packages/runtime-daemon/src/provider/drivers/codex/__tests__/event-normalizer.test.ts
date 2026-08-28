// Codex event-normalizer suite (Plan-005 T3.5).
//
// Spec coverage under test:
//   • `Spec-005 §Required Behavior` — drivers emit normalized runtime events,
//     not provider-native types. Asserted as: every pinned Codex inbound
//     method resolves to a Plan-006 `EventCategory` + `SessionEventType`, and
//     an unmapped method never resolves to a fabricated one.
//   • `Spec-005 §Required Behavior` — the required normalized event families.
//     Asserted as a two-sided coverage pin: which of the six the pinned Codex
//     inbound census reaches, and which it provably does not.
//
// Verifies invariant: none (T3.5 declares none; normalization is structural).
//
// Fixture discipline: the two `__fixtures__/` modules are METHOD census
// vectors derived from `docs/reference/provider-wire/codex.md` at pin
// `codex-cli 0.149.1`. The reference reproduces no inbound PAYLOAD body
// verbatim, so these are method vectors and never payload golden files. The
// delta-family members `turn/diff/updated` and `turn/plan/updated` — whose
// wire names come from the pinned binary's own `codex app-server
// generate-json-schema` output at that pin — went uncensused by the reference
// until 2026-08-28 and were reachable here only through typed constructors.
// They are census rows now, so the fixture-driven `it.each` covers them; the
// typed-constructor test is KEPT because it binds each literal to
// `CodexInboundFrameMethod` at COMPILE time, which an `it.each` mapping census
// rows to plain strings cannot do.

import {
  EVENT_DISPOSITION_BY_KIND,
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
import { CODEX_TOOL_NAMES } from "../tools.js";

// --------------------------------------------------------------------------
// The expectation table — written INDEPENDENTLY of the production record.
// --------------------------------------------------------------------------
//
// Deliberately a second, hand-written statement of the mapping rather than
// anything derived from `CODEX_FRAME_NORMALIZATION_BY_METHOD`: a test that
// read its expectations out of the table under test would assert only that a
// Map round-trips. Every row here is transcribed from the corpus source named
// in its comment block, so a silent edit to the production table fails here.

interface ExpectedNormalizedRow {
  readonly transport: CodexInboundFrameTransport;
  readonly family: EventCategory;
  readonly eventType: SessionEventType;
  readonly normalizedKind: string | null;
}

const EXPECTED_NORMALIZED_ROWS: ReadonlyMap<CodexInboundFrameMethod, ExpectedNormalizedRow> =
  new Map([
    // ServerRequest — callback tool + the seven asks that surface as
    // `driver_ask.*` (Plan-005 T3.14 P1-4-driver).
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
        eventType: "driver_ask.requested",
        normalizedKind: "user_input_request",
      },
    ],
    [
      "mcpServer/elicitation/request",
      {
        transport: "server-request",
        family: "interactive_request",
        eventType: "driver_ask.requested",
        normalizedKind: "user_input_request",
      },
    ],
    [
      "item/commandExecution/requestApproval",
      {
        transport: "server-request",
        family: "interactive_request",
        eventType: "driver_ask.requested",
        normalizedKind: "approval_request",
      },
    ],
    [
      "item/fileChange/requestApproval",
      {
        transport: "server-request",
        family: "interactive_request",
        eventType: "driver_ask.requested",
        normalizedKind: "approval_request",
      },
    ],
    [
      "item/permissions/requestApproval",
      {
        transport: "server-request",
        family: "interactive_request",
        eventType: "driver_ask.requested",
        normalizedKind: "approval_request",
      },
    ],
    [
      "execCommandApproval",
      {
        transport: "server-request",
        family: "interactive_request",
        eventType: "driver_ask.requested",
        normalizedKind: "approval_request",
      },
    ],
    [
      "applyPatchApproval",
      {
        transport: "server-request",
        family: "interactive_request",
        eventType: "driver_ask.requested",
        normalizedKind: "approval_request",
      },
    ],
    // Legacy notifications (codex.md §Method namespace).
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
    // Guardian + autoApprovalReview (Plan-006 delta row: `approval_flow`
    // observability, "never a Cedar-pipeline bypass").
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
      "item/autoApprovalReview/started",
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
        eventType: "moderation.review_flagged",
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
    [
      "turn/moderationMetadata",
      {
        transport: "server-notification",
        family: "approval_flow",
        eventType: "moderation.review_flagged",
        normalizedKind: null,
      },
    ],
    // Goals (Plan-006 delta row: `session_lifecycle`).
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
    [
      "model/safetyBuffering/updated",
      {
        transport: "server-notification",
        family: "session_lifecycle",
        eventType: "session.notice",
        normalizedKind: "notification",
      },
    ],
    // `process/*` (Plan-006 delta row: `tool_activity`).
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
    // `turn/diff/updated` | `turn/plan/updated` — disposition from the Plan-006
    // delta row, wire names from the binary's generator at codex-cli 0.149.1
    // (the delta row carried truncated forms until its 2026-08-28 correction).
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
];

/**
 * The six required normalized families, verbatim from
 * `Spec-005 §Required Behavior`: "run lifecycle, assistant output, tool
 * activity, interactive request, artifact publication, usage or quota
 * telemetry where available", named with their `EventCategory` literals.
 */
const REQUIRED_NORMALIZED_FAMILIES: readonly EventCategory[] = [
  "run_lifecycle",
  "assistant_output",
  "tool_activity",
  "interactive_request",
  "artifact_publication",
  "usage_telemetry",
];

/**
 * The eight realtime notifications deliberately EXCLUDED from the census.
 *
 * Spelled in full in Plan-005 T3.11, which states the normalizer "routes each
 * of the eight Codex realtime wire kinds ... to the default-branch
 * diagnostic". Pinned here so a future edit that quietly maps one of them into
 * a family fails: the `realtime_*` Spec-006 family is reserved with no V1
 * emitter, so any family it were mapped to would be fabricated.
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
];

function normalizedRowsOfCensus(): readonly CodexNormalizedFamilyEmission[] {
  return CODEX_INBOUND_FRAME_METHODS.map((method) => normalizeCodexInboundFrame(method)).filter(
    (normalization): normalization is CodexNormalizedFamilyEmission =>
      normalization.disposition === "normalized",
  );
}

// --------------------------------------------------------------------------

describe("Codex event normalizer — fixture census integrity", () => {
  it("carries all ten pinned ServerRequest methods", () => {
    expect(CODEX_SERVER_REQUEST_METHOD_VECTORS).toHaveLength(
      CODEX_SERVER_REQUEST_METHOD_COUNT_AT_PIN,
    );
    const methods = CODEX_SERVER_REQUEST_METHOD_VECTORS.map((vector) => vector.method);
    expect(new Set(methods).size).toBe(CODEX_SERVER_REQUEST_METHOD_COUNT_AT_PIN);
  });

  it("carries exactly the nineteen experimental-gated notifications the pin enumerates", () => {
    const gated = CODEX_SERVER_NOTIFICATION_METHOD_VECTORS.filter(
      (vector) => vector.experimentalGatedAtPin,
    );
    expect(gated).toHaveLength(CODEX_GATED_SERVER_NOTIFICATION_COUNT_AT_PIN);
    // All eight realtime names are inside that nineteen.
    for (const realtimeMethod of EXCLUDED_REALTIME_METHODS) {
      expect(gated.map((vector) => vector.method)).toContain(realtimeMethod);
    }
  });

  it("is honest about being a strict subset of the 75-arm notification root", () => {
    // The reference enumerates only part of the union by name; asserting the
    // subset relation keeps a future reader from mistaking this fixture for a
    // completeness claim about the Codex notification surface.
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
        // The only ServerRequests without a family emission are the two
        // control-plane frames; anything else reaching here is a mapping drift.
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
    CODEX_SERVER_NOTIFICATION_METHOD_VECTORS.filter(
      (vector) =>
        vector.presentInPinnedGeneratedSchema && !EXCLUDED_REALTIME_METHODS.includes(vector.method),
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
    // Their DISPOSITION comes from
    // `Plan-006 §Event-Kind Disposition Table (surveyed-runtime normalized census)`'s Codex delta row and their WIRE
    // NAMES from the pinned binary's own generator output at codex-cli
    // 0.149.1 (the delta row carried both truncated until 2026-08-28).
    // Exercised as typed values here on top of the census coverage above: the
    // annotation binds each literal to `CodexInboundFrameMethod` at compile
    // time, so dropping a member from the union fails to BUILD rather than
    // failing a string lookup at run time.
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
    // Not a hole in this table — a corpus fact, asserted so it stays loud.
    // `Plan-006 §Event-Kind Disposition Table (surveyed-runtime normalized census)` assigns NO normalized census
    // kind to `artifact_publication`: `EVENT_DISPOSITION_BY_KIND` names
    // `run_lifecycle`, `assistant_output`, `tool_activity`,
    // `interactive_request`, `approval_flow`, `usage_telemetry` and
    // `session_lifecycle` as target categories and never that one, and the
    // Codex `turn/diff/updated` delta row is routed to `tool_activity` (`diff`, row
    // 32) rather than to `diff.created`. And the family's emitter is not a
    // driver at all: Plan-006's event-family ownership table assigns all six
    // `artifact_publication` types to Plan-014, so a Codex normalizer
    // producing one would assert an emitter the corpus gives to another plan.
    // (Corrected 2026-08-27: an earlier revision of this comment also named
    // Plan-011, which owns Gitflow PR and diff attribution and emits none of
    // these six.) Should a Codex frame ever gain an artifact-publication
    // mapping, this assertion fires and the author must justify the new
    // producer. Full grounding lives in the normalizer header under "Why
    // `artifact_publication` is reachable from no Codex frame".
    const reached = new Set(normalizedRowsOfCensus().map((row) => row.family));
    expect(reached.has("artifact_publication")).toBe(false);

    const dispositionCategories = new Set(
      [...EVENT_DISPOSITION_BY_KIND.values()]
        .map((entry) => entry.category)
        .filter((category): category is EventCategory => category !== undefined),
    );
    expect(dispositionCategories.has("artifact_publication")).toBe(false);
  });

  it("reaches only families the Plan-006 taxonomy recognizes", () => {
    for (const row of normalizedRowsOfCensus()) {
      // A family is legitimate exactly when the census registry agrees that
      // the row's target literal lives in it.
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
    // The runtime consume of this registry is Plan-005 T3.11's, deliberately
    // not this module's. Cross-checking it HERE is what keeps the two from
    // drifting in the meantime: a row whose family contradicts the registry's
    // category for its own census kind fails now, not at T3.11 integration.
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
        // Category equality only: the registry documents `eventType` as the
        // row's PRIMARY target, with outcome-dependent fan-out left to this
        // normalizer, so type equality is not an invariant.
        expect(entry.category, `family drift on kind ${row.normalizedKind}`).toBe(row.family);
      } else {
        // A correlate/discard kind carries no taxonomy target, so a family
        // emission built on it would be inventing one.
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
    // The distinction the Plan-006 no-silent-capability-loss default turns on:
    // an unmapped frame must be observable. Pre-T3.11 that means a throw; T3.11
    // replaces the throw with an operator-visible diagnostic record.
    let returned: CodexFrameNormalization | undefined;
    try {
      returned = normalizeCodexInboundFrame("codex/unheard-of");
    } catch {
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });

  it("refuses prototype-chain keys instead of resolving them", () => {
    // The reason the lookup is a ReadonlyMap: an object-literal table would
    // resolve these to truthy non-normalization values and hand a fabricated
    // shape to the timeline.
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

  it("refuses all eight excluded realtime notifications (the T3.11 routing pin)", () => {
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
      // Identity, not just deep equality: the resolver hands out shared frozen
      // singletons, so a future refactor that starts allocating per call would
      // fail here before it could introduce a per-call divergence.
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

// --------------------------------------------------------------------------
// Emission readiness — the derived stamp.
// --------------------------------------------------------------------------
//
// The stamp answers a question distinct from "which family": whether the
// named `SessionEventType` may be built into a `SessionEvent` envelope TODAY
// (Plan-006 T1.10's flip-is-not-emission rule). It is derived at map-build
// from the live `SESSION_EVENT_TYPES` roster, never hand-stated per row, so
// it widens by itself when an emitting plan registers a payload variant.
//
// Deliberately NOT folded into `EXPECTED_NORMALIZED_ROWS`: restating
// `payload-variant-pending` on 26 hand-written rows would reintroduce, inside
// the test, exactly the hard-coding the derivation exists to eliminate. The
// stamp is instead checked against the resolver, and the resolver is checked
// against contracts.
//
// -- The exact width of this guard, measured by perturbation --
//
// Hard-coding a stamp ON A RECORD ROW does not compile: the table-row type
// `Omit`s the key, and `disposition` is a discriminant, so TypeScript narrows
// to the one constituent before the excess-property check and reports TS2353.
// Hard-coding the WRONG value at the derivation site fails two tests below.
//
// The one case these tests cannot distinguish: hard-coding, at the derivation
// site and behind an explicit `as` cast, the value that is currently correct
// for every row. That produces byte-identical output today because all 11
// Codex targets are pending. It is not, however, undetectable forever — the
// row-level assertion compares each stamp to the resolver's live answer, so
// the deception breaks the instant any Codex target gains a registered
// payload variant. The ratchet test at the end of this block is what makes
// that moment loud instead of silent. Stated here rather than left as an
// implied claim of total coverage.

describe("Codex event normalizer — emission readiness is derived, not stated", () => {
  it("resolves a registered payload-variant target as envelope-constructible", () => {
    // Reached by calling the resolver directly rather than through a row: at
    // the current tree state NO Codex target is registered, so this arm is
    // otherwise unprovable. `session.created` is in the roster today.
    expect(SESSION_EVENT_TYPES).toContain("session.created");
    expect(resolveCodexEmissionReadiness("session.created")).toBe("envelope-constructible");
  });

  it("resolves an unregistered target as payload-variant-pending", () => {
    expect(SESSION_EVENT_TYPES).not.toContain("tool.invoked");
    expect(resolveCodexEmissionReadiness("tool.invoked")).toBe("payload-variant-pending");
  });

  it("agrees with the live contracts roster for every registered type", () => {
    for (const registeredType of SESSION_EVENT_TYPES) {
      expect(resolveCodexEmissionReadiness(registeredType)).toBe("envelope-constructible");
    }
  });

  it("stamps every normalized census row with the resolver's own answer", () => {
    // This is the anti-hard-coding assertion. If a row ever hand-stated a
    // stamp that disagreed with the live roster, this fails; if the roster
    // widens, the row follows automatically and this still passes.
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

  it("records that no Codex target is envelope-constructible at this tree state", () => {
    // A ratchet, not an aspiration. Plan-006 registers payload variants
    // independently of this driver; when the first Codex target lands one,
    // this fails and whoever landed it re-derives the claim in the report
    // rather than discovering the drift later. Failure here is GOOD NEWS.
    const constructibleTargets = [...CODEX_FRAME_NORMALIZATION_BY_METHOD.values()]
      .filter((normalization) => normalization.disposition === "normalized")
      .filter((normalization) => normalization.emissionReadiness === "envelope-constructible")
      .map((normalization) => normalization.eventType);

    expect(constructibleTargets).toEqual([]);
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

// --------------------------------------------------------------------------
// Tool-identity binding — the `tools.ts` (T3.4) namespace seam.
// --------------------------------------------------------------------------
//
// `tools.ts` exports `CODEX_TOOL_NAMES` specifically so this module consumes
// the identity instead of restating literals. The production binding is the
// type annotation on `CODEX_TOOL_KEYED_APPROVAL_METHODS` — a namespace rename
// makes that declaration a compile error. These tests assert the runtime half
// the type cannot: that the bound methods are real census keys and that their
// embedded segments are live members of the namespace.

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
    // The failure this catches: a tool namespace change ripples into the
    // method literal, the method silently leaves the census, and approval
    // frames start reaching the unknown seam instead of interactive_request.
    for (const approvalMethod of CODEX_TOOL_KEYED_APPROVAL_METHODS) {
      expect(CODEX_INBOUND_FRAME_METHODS).toContain(approvalMethod);
      expect(CODEX_FRAME_NORMALIZATION_BY_METHOD.has(approvalMethod)).toBe(true);
    }
  });

  it("normalizes every tool-keyed approval method into interactive_request", () => {
    for (const approvalMethod of CODEX_TOOL_KEYED_APPROVAL_METHODS) {
      expect(normalizeCodexInboundFrame(approvalMethod)).toMatchObject({
        disposition: "normalized",
        transport: "server-request",
        family: "interactive_request",
        eventType: "driver_ask.requested",
      });
    }
  });

  it("covers exactly the two mutating tools that gate on approval at the pin", () => {
    // Pinned at two, not asserted as total over CODEX_TOOL_NAMES: the reverse
    // direction would demand `item/webSearch/requestApproval` and four more
    // that `docs/reference/provider-wire/codex.md` does not show. Inventing
    // them to satisfy a symmetry the protocol lacks is the transcription this
    // corpus forbids.
    expect([...CODEX_TOOL_KEYED_APPROVAL_METHODS].sort()).toEqual([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ]);
  });

  it("freezes the bound-method census against consumer mutation", () => {
    expect(Object.isFrozen(CODEX_TOOL_KEYED_APPROVAL_METHODS)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Negotiation-gated methods — the dormant-but-mapped declaration.
// --------------------------------------------------------------------------
//
// The driver ships `experimentalApi: false`, so every census member the pin
// marks experimental is unreachable today. The production module DECLARES that
// set rather than deriving it, because the gate state is in neither of its
// inputs: the generated schema does not encode it for notifications, and
// `tools.ts` knows nothing about negotiation. These tests are what keep the
// declaration honest — they pin it to the `__fixtures__/` gate tags, which are
// the transcription of codex.md §The experimental gate, across BOTH transports.

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
    // Set equality in BOTH directions. A census edit that adds a gated method
    // without declaring it fails here; so does a declaration naming a method
    // the fixtures do not tag.
    expect([...CODEX_NEGOTIATION_GATED_METHODS].sort()).toEqual(
      [...fixtureGatedCensusMethods()].sort(),
    );
  });

  it("covers both transports — the gate is not a notification-only concern", () => {
    // The regression this guards: reading codex.md's transport-level filter
    // (`should_skip_notification_for_connection`) and concluding only
    // notifications are gated. `item/tool/requestUserInput` is a REQUEST and
    // is the one EXPERIMENTAL-marked arm of the pinned binary's ten.
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
    // The point of the declaration: these rows stay in the census so a posture
    // flip or a pin bump inherits their disposition instead of routing twelve
    // settled frames into the T3.11 diagnostic at once.
    for (const gatedMethod of CODEX_NEGOTIATION_GATED_METHODS) {
      expect(CODEX_INBOUND_FRAME_METHODS).toContain(gatedMethod);
      expect(() => normalizeCodexInboundFrame(gatedMethod)).not.toThrow();
    }
  });

  it("excludes the realtime methods, which are suppressed rather than dormant", () => {
    // Two different exclusions with two different reasons, and conflating them
    // would be the bug: realtime frames are opted out BY NAME at the source and
    // target a family with no V1 emitter, so they are absent from the census
    // entirely; gated frames are settled dispositions awaiting delivery.
    for (const realtimeMethod of EXCLUDED_REALTIME_METHODS) {
      expect(CODEX_NEGOTIATION_GATED_METHODS).not.toContain(realtimeMethod);
      expect(CODEX_INBOUND_FRAME_METHODS).not.toContain(realtimeMethod);
    }
  });

  it("leaves the ungated remainder of the census reachable at the shipped posture", () => {
    // Non-vacuity: if this ever hit zero, the suite above would be asserting a
    // property of an empty set while the driver received nothing at all.
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
    // The comment on CODEX_NEGOTIATION_GATED_METHODS claims "1 of 10" requests
    // and "11 of this census's 25" notifications. A prose count that no test
    // reads is a count that drifts -- this one was wrong (24) on first write
    // and was caught by measuring rather than by re-reading.
    const rows = [...CODEX_FRAME_NORMALIZATION_BY_METHOD.values()];
    expect(rows.filter((row) => row.transport === "server-request")).toHaveLength(10);
    expect(rows.filter((row) => row.transport === "server-notification")).toHaveLength(25);

    const gatedByTransport = CODEX_NEGOTIATION_GATED_METHODS.map(
      (method) => CODEX_FRAME_NORMALIZATION_BY_METHOD.get(method)?.transport,
    );
    expect(gatedByTransport.filter((transport) => transport === "server-request")).toHaveLength(1);
    expect(
      gatedByTransport.filter((transport) => transport === "server-notification"),
    ).toHaveLength(11);
  });
});

// --------------------------------------------------------------------------
// Truncated delta-family names — a standing regression guard.
// --------------------------------------------------------------------------

describe("Codex event normalizer — the truncated delta names stay off the census", () => {
  it("refuses the truncated wire names the Plan-006 delta row once carried", () => {
    // `Plan-006 §Event-Kind Disposition Table (surveyed-runtime normalized census)`
    // spelled this family "`turn/diff` | `turn/plan` | `turn/moderationMetadata`"
    // until its 2026-08-28 correction. Regenerating the protocol schema from the
    // pinned binary (`codex app-server generate-json-schema` at codex-cli
    // 0.149.1) emits `turn/diff/updated` and `turn/plan/updated`; the bare
    // forms appear nowhere in its 75-arm `ServerNotification` root.
    //
    // The guard OUTLIVES the correction it was written against. The truncated
    // spellings are the intuitive ones, they survive in older revisions of this
    // corpus, and they are one keystroke from the real ones — so "restoring"
    // either must fail here rather than silently route real frames to the
    // unknown seam.
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
    // The pinned binary emits this one unsuffixed. Renaming it "for
    // consistency" with its two siblings would break a name that is correct.
    expect(CODEX_INBOUND_FRAME_METHODS).toContain("turn/moderationMetadata");
    expect(CODEX_INBOUND_FRAME_METHODS).not.toContain("turn/moderationMetadata/updated");
  });
});
