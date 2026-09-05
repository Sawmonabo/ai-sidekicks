// The two chips render their model and derive nothing of their own.
//
// Both files are here rather than in two because they share one claim, and the claim
// is the lane's second negative control: a chip that computed its own eligibility
// would still render something when handed a model with nothing in it. Each case
// below therefore asserts the absence as well as the presence.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentBindingReading } from "./agent-binding-read.js";
import type { ComposerChannelTarget, ComposerRunTarget } from "./chip-models.js";
import { PostureChip } from "./PostureChip.js";
import { TargetChip } from "./TargetChip.js";

/** Nothing was asked, which is what the channel path and an unmounted read read as. */
const NOTHING_ASKED: AgentBindingReading = {
  phase: "not-checked",
  payingAccountLabel: undefined,
  isProviderDefaultAccount: false,
  pendingSwitch: undefined,
  refusal: undefined,
};

/** One served roster read, with whatever the case is about layered on. */
function bindingRead(overrides: Partial<AgentBindingReading> = {}): AgentBindingReading {
  return { ...NOTHING_ASKED, phase: "read", ...overrides };
}

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
        model={{ target: RUN_TARGET, bindingClause: "claude · opus · high" }}
        binding={bindingRead({ payingAccountLabel: "work" })}
      />,
    );
    const text = container.textContent ?? "";

    expect(text).toContain("Ada");
    expect(text).toContain("running");
    expect(text).toContain("claude · opus · high");
    expect(text).toContain("work");
  });

  it("states the provider's default account rather than inventing a label", () => {
    // The roster served and named no account, which IS the registered default
    // paying — a different fact from an account whose label has not been read, and
    // the negative control is that neither renders the other's words.
    const { container } = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={bindingRead({ isProviderDefaultAccount: true })}
      />,
    );

    expect(container.textContent).toContain("Provider's default account");
    expect(container.textContent).not.toContain("Paying account not read");
  });

  it("renders an absence, never a handle, for an account whose label went unread", () => {
    const { container } = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={bindingRead()}
      />,
    );

    expect(container.textContent).toContain("Account label not read");
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("says nobody asked while the composer is addressed at a channel", () => {
    const { container } = render(
      <TargetChip
        model={{ target: CHANNEL_TARGET, bindingClause: undefined }}
        binding={NOTHING_ASKED}
      />,
    );

    // The channel path names no agent, so no roster read is armed — and the chip
    // renders no account arm at all rather than a "not read" about a question that
    // was never asked of a target that has no account.
    expect(container.textContent).not.toContain("Paying account");
    expect(container.textContent).not.toContain("Provider's default account");
  });

  it("carries the roster read's own refusal rather than falling silent", () => {
    const { container } = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={{
          ...NOTHING_ASKED,
          phase: "refused",
          refusal: {
            code: "wire-unregistered",
            detail: "Plan-016 owns registering `agent.list`.",
            origin: "growth-port",
          },
        }}
      />,
    );

    expect(container.textContent).toContain("wire-unregistered");
    expect(container.textContent).toContain("Plan-016 owns registering");
  });

  it("says the binding was not read rather than showing one it chose", () => {
    const { container } = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={NOTHING_ASKED}
      />,
    );

    expect(container.textContent).toContain("Binding not read");
    // The negative control: the absence must be the "not checked" kind, which is
    // "nobody asked" — not "empty", which would claim the agent has no binding.
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("marks a pending switch through the reply's own closed vocabulary", () => {
    const { container } = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: "claude · opus · high" }}
        binding={bindingRead({
          pendingSwitch: {
            switchId: "switch-1",
            appliesAt: "turn_boundary",
            interruptRequested: false,
          },
        })}
      />,
    );

    // The sentence comes from a record total over the two-member vocabulary, so the
    // wire-verbatim word never reaches a person: `turn_boundary` interpolated into
    // prose reads as English only by accident.
    expect(container.textContent).toContain("Switch applies at the next turn");
    expect(container.textContent).not.toContain("turn_boundary");
    // Eligibility is never derived in the renderer, and no wire member carries an
    // axis mutation today — so the chip offers no button at all.
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("renders no failed-switch chip, because neither carrier is reachable", () => {
    // The negative control for the fabricated third read: a switch failure travels
    // on `agent.configUpdate`'s response — a mutation this composer never issues —
    // or on `agent.provider_switch_failed`, an event `packages/contracts` does not
    // register. A reading that says a switch is pending renders exactly that, and
    // no arm of this chip can render a failure at all.
    const { container } = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={bindingRead({
          pendingSwitch: {
            switchId: "switch-1",
            appliesAt: "run_boundary",
            interruptRequested: true,
          },
        })}
      />,
    );

    expect(container.textContent).toContain("Switch applies at the next run");
    expect(container.querySelector(".meridian-chip--failure")).toBeNull();
  });

  it("describes an unnamed channel target rather than printing an id", () => {
    const { container } = render(
      <TargetChip
        model={{ target: { ...CHANNEL_TARGET, channelLabel: undefined }, bindingClause: undefined }}
        binding={NOTHING_ASKED}
      />,
    );
    expect(container.textContent).toContain("This session");
    expect(container.textContent).not.toContain(CHANNEL_TARGET.sessionId);
  });

  it("names an addressed channel differently from the session's own default", () => {
    const addressedChannelId = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
    const addressed = render(
      <TargetChip
        model={{
          target: { ...CHANNEL_TARGET, channelId: addressedChannelId, channelLabel: undefined },
          bindingClause: undefined,
        }}
        binding={NOTHING_ASKED}
      />,
    );
    const unaddressed = render(
      <TargetChip
        model={{
          target: { ...CHANNEL_TARGET, channelId: undefined, channelLabel: undefined },
          bindingClause: undefined,
        }}
        binding={NOTHING_ASKED}
      />,
    );

    // The negative control on the same defect the placeholder carried: falling
    // through an unread label to the unaddressed words rendered these identically.
    expect(addressed.container.textContent).not.toBe(unaddressed.container.textContent);
    expect(addressed.container.textContent).not.toContain(addressedChannelId);
    expect(unaddressed.container.textContent).toContain("This session");
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
