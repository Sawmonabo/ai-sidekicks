// Claude inbound frames: the run terminals against the pinned `result` subtypes and the asks a
// person must answer, and the fail-closed refusal of an unmapped kind.

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
