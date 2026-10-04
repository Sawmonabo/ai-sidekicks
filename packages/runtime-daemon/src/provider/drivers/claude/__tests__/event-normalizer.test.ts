// Claude inbound frames: the run terminals against the pinned `result` subtypes and the asks a
// person must answer; the fail-closed refusal of an unmapped kind; and the typed usage-limit
// signal read off the retry frame.

import { describe, expect, it } from "vitest";

import { captureThrow } from "../../../../__fixtures__/capture-failure.js";
import {
  CLAUDE_API_ERROR_TO_API_RETRY_MAPPING_ARM,
  CLAUDE_RESULT_SUBTYPES,
  CLAUDE_RESULT_SUBTYPE_CARRYING_RESULT_FIELD,
} from "../__fixtures__/stream-surface-census.js";
import {
  UnknownClaudeWireFrameError,
  classifyClaudeFrameFamilyForRouting,
  composeClaudeWireFrameKind,
  normalizeClaudeCanUseToolRequest,
  normalizeClaudeWireFrame,
  resolveClaudeFrameEmissionRoute,
  type ClaudeFrameNormalization,
  type ClaudeNormalizedCategoryEmission,
} from "../event-normalizer.js";
import { classifyClaudeUsageLimitSignal } from "../usage-limit-signal.js";
import { makeSilentDriverDiagnostics } from "../../../__fixtures__/silent-driver-diagnostics.js";

/** Narrow to the emitting arm, failing the test rather than silently skipping. */
function expectNormalized(
  normalization: ClaudeFrameNormalization,
): ClaudeNormalizedCategoryEmission {
  expect(normalization.disposition).toBe("normalized");
  if (normalization.disposition !== "normalized") {
    throw new Error("unreachable: assertion above already failed");
  }
  return normalization;
}

/**
 * Typed constructor for a Claude control-request frame. No request body is recorded, so frames are
 * built here rather than in `__fixtures__/`, where a hand-built body would pass for a recording.
 */
function buildControlRequestFrame(subtype: string): {
  readonly type: "control_request";
  readonly request: { readonly subtype: string };
} {
  return { type: "control_request", request: { subtype } };
}

describe("control-request asks", () => {
  it("maps a permission frame to approval.requested and an elicitation to question.asked", () => {
    const permissionFrame = buildControlRequestFrame("can_use_tool");
    expect(
      expectNormalized(
        normalizeClaudeWireFrame(
          composeClaudeWireFrameKind(permissionFrame.type, permissionFrame.request.subtype),
        ),
      ),
    ).toMatchObject({
      category: "approval_flow",
      eventType: "approval.requested",
      normalizedKind: "approval_request",
    });
    expect(expectNormalized(normalizeClaudeWireFrame("control_request/elicitation"))).toMatchObject(
      {
        category: "interactive_request",
        eventType: "question.asked",
        normalizedKind: "user_input_request",
      },
    );
    expect(normalizeClaudeWireFrame("control_request/request_user_dialog").disposition).toBe(
      "not-evented",
    );
  });

  it("splits Claude Code's question tool off the permission ask by tool name", () => {
    expect(expectNormalized(normalizeClaudeCanUseToolRequest("AskUserQuestion"))).toMatchObject({
      frameKind: "control_request/can_use_tool",
      category: "interactive_request",
      eventType: "question.asked",
      normalizedKind: "user_input_request",
      emissionReadiness: "envelope-constructible",
    });
    expect(expectNormalized(normalizeClaudeCanUseToolRequest("Bash"))).toMatchObject({
      category: "approval_flow",
      eventType: "approval.requested",
      normalizedKind: "approval_request",
    });
  });
});

describe("run terminals", () => {
  it("maps result/success to run.completed and the four error subtypes to run.failed", () => {
    const success = expectNormalized(
      normalizeClaudeWireFrame(`result/${CLAUDE_RESULT_SUBTYPE_CARRYING_RESULT_FIELD}`),
    );
    expect(success.eventType).toBe("run.completed");
    expect(success.normalizedKind).toBe("turn_complete");

    const failures = CLAUDE_RESULT_SUBTYPES.filter(
      (subtype) => subtype !== CLAUDE_RESULT_SUBTYPE_CARRYING_RESULT_FIELD,
    );
    expect(failures.length).toBeGreaterThan(0);
    for (const subtype of failures) {
      const normalization = expectNormalized(normalizeClaudeWireFrame(`result/${subtype}`));
      expect(normalization.eventType).toBe("run.failed");
      expect(normalization.normalizedKind).toBe("error");
    }
  });
});

describe("pinned stream surface", () => {
  it("maps system/api_error onto the same event as system/api_retry", () => {
    const [fromKind, toKind] = CLAUDE_API_ERROR_TO_API_RETRY_MAPPING_ARM;
    const from = expectNormalized(normalizeClaudeWireFrame(fromKind));
    const to = expectNormalized(normalizeClaudeWireFrame(toKind));
    expect(from.category).toBe(to.category);
    expect(from.eventType).toBe(to.eventType);
    expect(from.normalizedKind).toBe(to.normalizedKind);
    expect(to.eventType).toBe("usage.api_retry");
  });
});

describe("unknown frame handling", () => {
  it(
    "refuses an unmapped kind with a typed error rather than dropping it or fabricating a " +
      "category",
    () => {
      const thrown = captureThrow(() => {
        normalizeClaudeWireFrame("system/zzq_nonexistent_subtype");
      });
      expect(thrown).toBeInstanceOf(UnknownClaudeWireFrameError);
      const typed = thrown as UnknownClaudeWireFrameError;
      expect(typed.name).toBe("UnknownClaudeWireFrameError");
      // The diagnostic record needs the verbatim kind as data, not parsed out of the message.
      expect(typed.frameKind).toBe("system/zzq_nonexistent_subtype");

      for (const frameKind of [
        "assistant",
        "user",
        "SubagentStart",
        "SubagentStop",
        "prompt_suggestion",
        "system/prompt_suggestion",
        "",
      ]) {
        expect(() => normalizeClaudeWireFrame(frameKind)).toThrow(UnknownClaudeWireFrameError);
      }
    },
  );

  it("is immune to prototype-chain keys", () => {
    for (const hostileKey of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(() => normalizeClaudeWireFrame(hostileKey)).toThrow(UnknownClaudeWireFrameError);
    }
  });
});

describe("resolveClaudeFrameEmissionRoute", () => {
  it(
    "routes an unmapped kind to the diagnostic default branch — emitted, never thrown, never " +
      "enveloped",
    () => {
      const diagnostics = makeSilentDriverDiagnostics();
      const route = resolveClaudeFrameEmissionRoute("system/unheard_of", diagnostics);
      expect(route.route).toBe("diagnostic");
      if (route.route === "diagnostic") {
        expect(route.record.kind).toBe("unmapped_wire_kind");
        expect(route.record.rawWireType).toBe("system/unheard_of");
        expect(route.record.provider).toBe("claude");
      }
      expect(diagnostics.emittedRecordCount()).toBe(1);
      // The bare resolver still throws; the diagnostic route is the driver-core entry point.
      expect(() => normalizeClaudeWireFrame("system/unheard_of")).toThrow(
        UnknownClaudeWireFrameError,
      );
    },
  );
});

describe("classifyClaudeFrameFamilyForRouting", () => {
  it(
    "classifies an unlisted kind unknown with or without a usage reading, and never promotes a " +
      "connection-scoped one",
    () => {
      expect(
        classifyClaudeFrameFamilyForRouting("novel/unheard_of", { cumulativeUsage: undefined }),
      ).toEqual({ scope: "unknown" });

      const carriedReading = { cumulativeUsage: { namedTurnId: null, cumulative: { input: 10 } } };
      // Connection-scoped frames already route without an identity.
      expect(classifyClaudeFrameFamilyForRouting("system/init", carriedReading)).toEqual({
        scope: "connection",
      });
      // An unlisted kind stays unknown even when it carries a number.
      expect(classifyClaudeFrameFamilyForRouting("novel/unheard_of", carriedReading)).toEqual({
        scope: "unknown",
      });
    },
  );
});

// Frames carry the retry frame's recorded members: `{ type: "system", subtype: "api_retry",
// attempt, max_retries, retry_delay_ms, error_status, error }`.

/** A fixed observation clock, so the derived boundary is asserted, not approximated. */
const RETRY_OBSERVED_AT_EPOCH_MS = Date.parse("2026-08-31T12:00:00.000Z");

// The default is the ladder's final announced attempt on purpose: the negative controls below
// assert `null` because of the typed `error` member, and a mid-ladder default would let the
// attempt gate produce that `null` instead.
function apiRetryFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "api_retry",
    attempt: 10,
    max_retries: 10,
    retry_delay_ms: 60000,
    error_status: 429,
    error: "rate_limit",
    ...overrides,
  };
}

/** The whole signal a recognized, exhausted-ladder frame composes at the fixed clock. */
const EXHAUSTED_LADDER_SIGNAL = {
  cause: "plan-allowance-exhausted",
  resetBoundary: { resetsAt: "2026-08-31T12:01:00.000Z", provenance: "runtime-derived" },
} as const;

describe("classifyClaudeUsageLimitSignal — typed-only recognition on the retry frame", () => {
  it("emits the signal with a RUNTIME-DERIVED boundary composed from the backoff", () => {
    // The provider states a delay, not a reset; the provenance stamp stops a consumer showing the
    // derived instant as the provider's own answer.
    expect(classifyClaudeUsageLimitSignal(apiRetryFrame(), RETRY_OBSERVED_AT_EPOCH_MS)).toEqual({
      cause: "plan-allowance-exhausted",
      resetBoundary: { resetsAt: "2026-08-31T12:01:00.000Z", provenance: "runtime-derived" },
    });
  });

  it("fires ONLY on the ladder's final announced attempt, never mid-ladder", () => {
    // A recognized signal parks the work at once and, with a runtime-derived boundary, arms no
    // schedule; a signal while the provider is still retrying would park work about to complete.
    // Several attempts are checked so a gate that only moved the threshold still fails.
    for (const attempt of [1, 2, 9]) {
      expect(
        classifyClaudeUsageLimitSignal(
          apiRetryFrame({ attempt, max_retries: 10 }),
          RETRY_OBSERVED_AT_EPOCH_MS,
        ),
      ).toBeNull();
    }
    // The final announced retry, and anything past it, has exhausted the ladder.
    for (const attempt of [10, 11]) {
      expect(
        classifyClaudeUsageLimitSignal(
          apiRetryFrame({ attempt, max_retries: 10 }),
          RETRY_OBSERVED_AT_EPOCH_MS,
        ),
      ).toEqual(EXHAUSTED_LADDER_SIGNAL);
    }
  });

  it(
    "takes the null path when the ladder members " + "are absent, malformed, or announce no ladder",
    () => {
      // No signal means "not known to be limited": the run continues and a later failure takes the
      // ordinary failure path, rather than parking against a boundary the frame did not state.

      // A frame with neither member, written out because the helper always supplies both.
      expect(
        classifyClaudeUsageLimitSignal(
          { type: "system", subtype: "api_retry", retry_delay_ms: 60000, error: "rate_limit" },
          RETRY_OBSERVED_AT_EPOCH_MS,
        ),
      ).toBeNull();

      const unusableLadders: readonly Record<string, unknown>[] = [
        { attempt: undefined, max_retries: 10 },
        { attempt: 10, max_retries: undefined },
        // `"10" >= "10"` is true, so a comparison without the numeric guard would emit here.
        { attempt: "10", max_retries: "10" },
        { attempt: "10", max_retries: 10 },
        { attempt: 10, max_retries: null },
        { attempt: Number.NaN, max_retries: 10 },
        { attempt: 10, max_retries: [10] },
        // `max_retries: 0` announces no ladder; a bare finite check would let `0 >= 0` emit.
        { attempt: 0, max_retries: 0 },
        { attempt: -1, max_retries: -1 },
      ];
      for (const ladder of unusableLadders) {
        expect(
          classifyClaudeUsageLimitSignal(apiRetryFrame(ladder), RETRY_OBSERVED_AT_EPOCH_MS),
        ).toBeNull();
      }
    },
  );

  it("returns the CAUSE ALONE when the frame carries no usable delay", () => {
    for (const retryDelayMs of [undefined, null, 0, -1, Number.NaN, "60000", {}]) {
      expect(
        classifyClaudeUsageLimitSignal(
          apiRetryFrame({ retry_delay_ms: retryDelayMs }),
          RETRY_OBSERVED_AT_EPOCH_MS,
        ),
      ).toEqual({ cause: "plan-allowance-exhausted" });
    }
  });

  it("returns the CAUSE ALONE when the observation clock names no instant", () => {
    for (const observedAt of [Number.NaN, Number.POSITIVE_INFINITY, 1e18]) {
      expect(classifyClaudeUsageLimitSignal(apiRetryFrame(), observedAt)).toEqual({
        cause: "plan-allowance-exhausted",
      });
    }
  });

  it(
    "produces no signal from usage-limit prose " +
      "plus a 429 when the typed member says otherwise",
    () => {
      // Each frame carries a 429 and usage-limit prose, but its typed `error` says otherwise.
      const proseAndStatusFrames: readonly unknown[] = [
        apiRetryFrame({
          error: "server_error",
          error_status: 429,
          message: "Rate limit exceeded — usage limit reached, retry after 60s",
        }),
        apiRetryFrame({
          error: "overloaded",
          error_status: 429,
          detail: "You have exceeded your plan's usage limit.",
        }),
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          error_status: 429,
          exitCode: 1,
          result: "Claude usage limit reached. Your limit will reset at 3pm.",
        },
        { type: "system", subtype: "api_error", error_status: 429, error: "rate_limit" },
      ];
      for (const frame of proseAndStatusFrames) {
        expect(classifyClaudeUsageLimitSignal(frame, RETRY_OBSERVED_AT_EPOCH_MS)).toBeNull();
      }
    },
  );

  it("does not read `error_status` — a bare 429 is not evidence an allowance is spent", () => {
    // Positive control: the same frame is recognized on its typed member and silent once that
    // member changes, with the status 429 throughout.
    expect(
      classifyClaudeUsageLimitSignal(
        apiRetryFrame({ error_status: 429 }),
        RETRY_OBSERVED_AT_EPOCH_MS,
      ),
    ).not.toBeNull();
    expect(
      classifyClaudeUsageLimitSignal(
        apiRetryFrame({ error: "overloaded", error_status: 429 }),
        RETRY_OBSERVED_AT_EPOCH_MS,
      ),
    ).toBeNull();
    // The typed member alone is enough.
    const { error_status: _omitted, ...withoutStatus } = apiRetryFrame();
    expect(
      classifyClaudeUsageLimitSignal(withoutStatus, RETRY_OBSERVED_AT_EPOCH_MS),
    ).not.toBeNull();
  });

  it("yields NOTHING — never a default-caused signal — on unparseable or absent input", () => {
    const unrecognized: readonly unknown[] = [
      null,
      undefined,
      "api_retry",
      42,
      [],
      [apiRetryFrame()],
      {},
      apiRetryFrame({ type: "assistant" }),
      apiRetryFrame({ subtype: "api_error" }),
      apiRetryFrame({ error: undefined }),
      apiRetryFrame({ error: null }),
      apiRetryFrame({ error: 429 }),
      apiRetryFrame({ error: { type: "rate_limit" } }),
    ];
    for (const frame of unrecognized) {
      expect(classifyClaudeUsageLimitSignal(frame, RETRY_OBSERVED_AT_EPOCH_MS)).toBeNull();
    }
  });
});
