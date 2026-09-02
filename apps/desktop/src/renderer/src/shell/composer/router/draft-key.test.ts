// One address, one key — and two addresses never one key.
//
// The failure the second claim catches is silent and specific: two composer
// addresses collapsing onto one key means the text a person wrote for one target
// reappears under another, which reads as the console having retargeted their
// message rather than as a bug.

import { describe, expect, it } from "vitest";

import type { ComposerChannelTarget, ComposerRunTarget } from "../chips/chip-models.js";
import { composerDraftKey } from "./draft-key.js";

function channelTarget(overrides: Partial<ComposerChannelTarget> = {}): ComposerChannelTarget {
  return {
    path: "channel-message",
    sessionId: "session-1",
    channelId: undefined,
    workspaceId: undefined,
    channelLabel: undefined,
    ...overrides,
  };
}

function runTarget(overrides: Partial<ComposerRunTarget> = {}): ComposerRunTarget {
  return {
    path: "provider-bound",
    sessionId: "session-1",
    agentId: "agent-implementer",
    agentName: "Ada",
    targetRunId: "run-01",
    expectedRunVersion: 4,
    runState: "running",
    providerFailureDetail: undefined,
    ...overrides,
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
