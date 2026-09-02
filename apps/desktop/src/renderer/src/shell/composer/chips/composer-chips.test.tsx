// The two chips render their model and derive nothing of their own.
//
// Both files are here rather than in two because they share one claim, and the claim
// is the lane's second negative control: a chip that computed its own eligibility
// would still render something when handed a model with nothing in it. Each case
// below therefore asserts the absence as well as the presence.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ComposerChannelTarget, ComposerRunTarget } from "./chip-models.js";
import { PostureChip } from "./PostureChip.js";
import { TargetChip } from "./TargetChip.js";

const RUN_TARGET: ComposerRunTarget = {
  path: "provider-bound",
  sessionId: "session-1",
  agentId: "agent-implementer",
  agentName: "Ada",
  driverName: "claude",
  targetRunId: "run-01",
  expectedRunVersion: 4,
  runState: "running",
  providerFailureDetail: undefined,
};

const CHANNEL_TARGET: ComposerChannelTarget = {
  path: "channel-message",
  sessionId: "session-1",
  channelId: undefined,
  workspaceId: undefined,
  channelLabel: "main",
};

describe("TargetChip — every fact on it came from the wire", () => {
  it("names the agent, its state, its binding, and its paying account", () => {
    const { container } = render(
      <TargetChip
        model={{
          target: RUN_TARGET,
          bindingClause: "claude · opus · high",
          payingAccountLabel: "work",
          pendingSwitchBoundary: undefined,
          switchFailureReason: undefined,
        }}
      />,
    );
    const text = container.textContent ?? "";

    expect(text).toContain("Ada");
    expect(text).toContain("running");
    expect(text).toContain("claude · opus · high");
    expect(text).toContain("work");
  });

  it("says the binding was not read rather than showing one it chose", () => {
    const { container } = render(
      <TargetChip
        model={{
          target: RUN_TARGET,
          bindingClause: undefined,
          payingAccountLabel: undefined,
          pendingSwitchBoundary: undefined,
          switchFailureReason: undefined,
        }}
      />,
    );

    expect(container.textContent).toContain("Binding not read");
    // The negative control: the absence must be the "not checked" kind, which is
    // "nobody asked" — not "empty", which would claim the agent has no binding.
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("marks a pending switch and a failed one, and offers no control for either", () => {
    const { container } = render(
      <TargetChip
        model={{
          target: RUN_TARGET,
          bindingClause: "claude · opus · high",
          payingAccountLabel: undefined,
          pendingSwitchBoundary: "turn",
          switchFailureReason: "agent.provider_axis_invalid",
        }}
      />,
    );

    expect(container.textContent).toContain("Switch applies at the next turn");
    expect(container.textContent).toContain("agent.provider_axis_invalid");
    // Eligibility is never derived in the renderer, and no wire member carries an
    // axis mutation today — so the chip offers no button at all.
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("describes an unnamed channel target rather than printing an id", () => {
    const { container } = render(
      <TargetChip
        model={{
          target: { ...CHANNEL_TARGET, channelLabel: undefined },
          bindingClause: undefined,
          payingAccountLabel: undefined,
          pendingSwitchBoundary: undefined,
          switchFailureReason: undefined,
        }}
      />,
    );
    expect(container.textContent).toContain("This session");
    expect(container.textContent).not.toContain(CHANNEL_TARGET.sessionId);
  });
});

describe("PostureChip — the posture the run got, or the reason there is none", () => {
  it("renders the stamped posture's mode, network stance, and root count", () => {
    const { container } = render(
      <PostureChip
        model={{
          stamped: {
            mode: "workspace-sandboxed",
            credentialPolicyRef: "sha256:abc",
            networkAccess: "none",
            writableRoots: ["/repo", "/tmp"],
          },
        }}
      />,
    );
    const text = container.textContent ?? "";

    expect(text).toContain("workspace-sandboxed");
    expect(text).toContain("none");
    expect(text).toContain("2 writable roots");
  });

  it("says posture is set by policy rather than implying nobody set one", () => {
    const { container } = render(<PostureChip model={{ stamped: undefined }} />);

    expect(container.textContent).toContain("Posture not stamped");
    // The negative control for the case above: with nothing stamped there is no
    // chip at all, so no posture value on screen is one the console chose.
    expect(container.querySelector(".meridian-chip")).toBeNull();
  });

  it("does not offer a posture mutation, because the wire carries none", () => {
    const { container } = render(
      <PostureChip
        model={{
          stamped: { mode: "trusted", networkAccess: "full", writableRoots: ["/repo"] },
        }}
      />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain("1 writable root");
  });
});
