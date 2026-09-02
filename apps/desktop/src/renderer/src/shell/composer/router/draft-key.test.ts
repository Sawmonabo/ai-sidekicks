// One address, one key — and two addresses never one key.
//
// The failure the second claim catches is silent and specific: two composer
// addresses collapsing onto one key means the text a person wrote for one target
// reappears under another, which reads as the console having retargeted their
// message rather than as a bug.

import { describe, expect, it } from "vitest";

import type { ComposerChannelTarget, ComposerRunTarget } from "../chips/chip-models.js";
import { composerDraftKey } from "./draft-key.js";

/**
 * The axes a case varies, named one by one.
 *
 * Not `Partial<ComposerTarget>` spread over a complete object: under this package's
 * `exactOptionalPropertyTypes` that turns every required member optional, so the
 * helper would stop proving it builds a real target at all.
 */
interface TargetAxes {
  readonly sessionId?: string;
  readonly channelId?: string;
  readonly agentId?: string;
  readonly targetRunId?: string;
}

function channelTarget(axes: TargetAxes = {}): ComposerChannelTarget {
  return {
    path: "channel-message",
    sessionId: axes.sessionId ?? "session-1",
    channelId: axes.channelId,
    workspaceId: undefined,
    channelLabel: undefined,
  };
}

function runTarget(axes: TargetAxes = {}): ComposerRunTarget {
  return {
    path: "provider-bound",
    sessionId: axes.sessionId ?? "session-1",
    agentId: axes.agentId ?? "agent-implementer",
    agentName: "Ada",
    driverName: "claude",
    targetRunId: axes.targetRunId ?? "run-01",
    expectedRunVersion: 4,
    runState: "running",
    providerFailureDetail: undefined,
  };
}

describe("composerDraftKey — the address the chip names", () => {
  it("keys a provider-bound composer on the agent, not the run it happens to steer", () => {
    // The steered run moves as the daemon starts and settles turns. Keying on it
    // would empty the line mid-sentence every time a turn ended.
    const sameAgentLaterRun = runTarget({ targetRunId: "run-9" });
    expect(composerDraftKey(runTarget())).toBe(composerDraftKey(sameAgentLaterRun));
  });

  it("gives two agents in one session different keys", () => {
    expect(composerDraftKey(runTarget())).not.toBe(
      composerDraftKey(runTarget({ agentId: "agent-reviewer" })),
    );
  });

  it("gives two sessions on one agent different keys", () => {
    expect(composerDraftKey(runTarget())).not.toBe(
      composerDraftKey(runTarget({ sessionId: "session-2" })),
    );
  });

  it("separates the session default channel from a named one", () => {
    expect(composerDraftKey(channelTarget())).not.toBe(
      composerDraftKey(channelTarget({ channelId: "channel-a" })),
    );
  });

  it("never gives a channel address and a run address the same key", () => {
    // The discriminator leads the key, so the two arms' key spaces are disjoint by
    // construction rather than by the identifiers happening to differ.
    expect(composerDraftKey(channelTarget({ channelId: "agent-implementer" }))).not.toBe(
      composerDraftKey(runTarget()),
    );
  });
});
