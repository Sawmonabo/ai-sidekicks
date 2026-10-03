// One address gives one key, and two addresses never share one: a collision would show the
// text written for one target under another.

import { describe, expect, it } from "vitest";

import type { ComposerSessionTarget, ComposerRunTarget } from "../composer-target.js";
import { composerDraftKey } from "./draft-key.js";

/**
 * The axes a case varies. Not `Partial<ComposerTarget>` spread over a complete object:
 * `exactOptionalPropertyTypes` would make every required member optional.
 */
interface TargetAxes {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly targetRunId?: string;
}

function sessionTarget(axes: TargetAxes = {}): ComposerSessionTarget {
  return {
    path: "session-message",
    sessionId: axes.sessionId ?? "session-1",
  };
}

function runTarget(axes: TargetAxes = {}): ComposerRunTarget {
  return {
    path: "provider-bound",
    sessionId: axes.sessionId ?? "session-1",
    agentId: axes.agentId ?? "agent-implementer",
    driverName: "claude",
    targetRunId: axes.targetRunId ?? "run-01",
    expectedRunVersion: 4,
    providerFailureDetail: undefined,
  };
}

describe("composerDraftKey — the address the chip names", () => {
  it("keys a provider-bound composer on the agent, not the run it happens to steer", () => {
    // The steered run moves as turns start and settle; keying on it would empty the line.
    const sameAgentLaterRun = runTarget({ targetRunId: "run-9" });
    expect(composerDraftKey(runTarget())).toBe(composerDraftKey(sameAgentLaterRun));
  });

  it("gives two sessions on one agent different keys", () => {
    expect(composerDraftKey(runTarget())).not.toBe(
      composerDraftKey(runTarget({ sessionId: "session-2" })),
    );
  });

  it("gives two sessions on the session path different keys", () => {
    expect(composerDraftKey(sessionTarget())).not.toBe(
      composerDraftKey(sessionTarget({ sessionId: "session-2" })),
    );
  });
});
