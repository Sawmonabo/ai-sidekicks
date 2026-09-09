// The two chips render their model and derive nothing of their own.
//
// Both files are here rather than in two because they share one claim, and the claim
// is the lane's second negative control: a chip that computed its own eligibility
// would still render something when handed a model with nothing in it. Each case
// below therefore asserts the absence as well as the presence.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentSwitchSettlement } from "../../../console/bridge/index.js";
import type { AgentBindingSwitchHolder } from "../../../console/agents/index.js";
import type { AgentBindingReading } from "./agent-binding-read.js";
import type { ComposerChannelTarget, ComposerRunTarget } from "./chip-models.js";
import { PostureChip } from "./PostureChip.js";
import type { TargetAxisReach } from "./target-axis-reach.js";
import { TargetChip } from "./TargetChip.js";

/**
 * A reach the rail would have resolved, with one settlement layered on.
 *
 * Hand-built here on purpose: this suite is about what the chip RENDERS from what it
 * is handed, and the resolution that produces these arms has its own suite next door.
 */
function axisReachOffered(overrides: Partial<AgentBindingSwitchHolder> = {}): TargetAxisReach {
  return {
    reach: "offered",
    control: {
      agent: { agentId: "agent-implementer", name: "Ada" },
      catalog: { catalog: { kind: "not-loaded" }, reopen: () => undefined },
      switching: {
        isSubmitting: false,
        settled: undefined,
        refusal: undefined,
        apply: () => undefined,
        ...overrides,
      },
    },
  };
}

/** The same reach with one settled round layered on, which is the common case. */
function axisReachSettled(settlement: AgentSwitchSettlement): TargetAxisReach {
  return axisReachOffered({ settled: { settlement } });
}

/** Nothing was asked, which is what the channel path and an unmounted read read as. */
const NOTHING_ASKED: AgentBindingReading = {
  phase: "not-checked",
  payingAccountLabel: undefined,
  isProviderDefaultAccount: false,
  pendingSwitch: undefined,
  agent: undefined,
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
            code: "reply-unreadable",
            detail: "The roster reply did not parse.",
            origin: "growth-port",
          },
        }}
      />,
    );

    expect(container.textContent).toContain("reply-unreadable");
    expect(container.textContent).toContain("did not parse");
  });

  it("says nobody asked for a wire this build does not carry", () => {
    // The growth port's own rule: `wire-unregistered` is the ONE code a live bridge
    // produces, and it renders as the "not checked" kind of nothing rather than as a
    // read that failed. The chip rendered it as an alert glyph and a mono code — an
    // error treatment for a question this build never put.
    const { container } = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={{
          ...NOTHING_ASKED,
          phase: "refused",
          refusal: {
            code: "wire-unregistered",
            detail: "Not checked — agent.list is not registered on this build yet.",
            origin: "growth-port",
          },
        }}
      />,
    );

    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    // The negative controls: not the error treatment, and the code is not paraded as
    // a mono figure for a wire nobody asked about.
    expect(container.querySelector(".meridian-nothing--error")).toBeNull();
    expect(container.textContent).not.toContain("wire-unregistered");
  });

  it("renders the account plane's refusal on a roster read that served", () => {
    // The join attaches the account plane's refusal on the arm where the ROSTER
    // answered and only the label is missing. The chip tested the phase before the
    // reason and fell through to "the account registry has not reported a label",
    // which says nobody asked about a read that failed.
    const { container } = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={bindingRead({
          refusal: {
            code: "reply-unreadable",
            detail: "The account registry reply did not parse.",
            origin: "provider-accounts",
          },
        })}
      />,
    );

    expect(container.textContent).toContain("reply-unreadable");
    expect(container.textContent).toContain("did not parse");
    expect(container.textContent).not.toContain("has not reported a label");
  });

  it("is a refusal on a refused read that carried no reason", () => {
    // Not reachable from today's producer, and the arm is still owed: the component
    // is a total function over the reading, and a refused phase with no reason fell
    // through to a sentence claiming the roster HAD answered.
    const { container } = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={{ ...NOTHING_ASKED, phase: "refused" }}
      />,
    );

    expect(container.querySelector(".meridian-nothing--error")).not.toBeNull();
    expect(container.textContent).toContain("Paying account not read");
    expect(container.textContent).not.toContain("has not reported a label");
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
            pendingAxes: [{ axis: "modelId", value: "opus" }],
          },
        })}
      />,
    );

    // The sentence comes from the design's own record, so the wire-verbatim word
    // never reaches a person for a boundary this console has a sentence for:
    // `turn_boundary` interpolated into prose reads as English only by accident.
    expect(container.textContent).toContain("Switch applies at the next turn");
    expect(container.textContent).not.toContain("turn_boundary");
    // Eligibility is never derived in the renderer: this chip was handed no axis
    // reach at all, so it offers no control and states nothing about one.
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("renders the immediate arm of a failed switch, and nothing for the deferred one", () => {
    // The two carriers are not alike now. The IMMEDIATE arm is
    // `agent.configUpdate`'s own response, which the rail's latch holds and hands
    // over on `axes` — so it renders. The DEFERRED arm rides
    // `agent.provider_switch_failed`, an event `packages/contracts` does not
    // register, so no reading can carry one and the pending clause stands alone.
    const failed = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={bindingRead()}
        axes={axisReachSettled({ status: "failed", reason: "account_unavailable" })}
      />,
    );
    const pendingOnly = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={bindingRead({
          pendingSwitch: {
            switchId: "switch-1",
            appliesAt: "run_boundary",
            interruptRequested: true,
            pendingAxes: [{ axis: "driverName", value: "codex" }],
          },
        })}
      />,
    );

    expect(failed.container.querySelector(".meridian-chip--failure")).not.toBeNull();
    // The reason is the wire's own word, in mono, rather than prose this console wrote.
    expect(failed.container.textContent).toContain("account_unavailable");
    // The negative control: a reading that only says a switch is PENDING renders no
    // failure at all, so the two states are never confused for one another.
    expect(pendingOnly.container.textContent).toContain("Switch applies at the next run");
    expect(pendingOnly.container.querySelector(".meridian-chip--failure")).toBeNull();
  });

  it("says the axis change is not reachable rather than drawing a dead control", () => {
    const { container } = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={bindingRead()}
        axes={{ reach: "unreachable" }}
      />,
    );

    expect(container.textContent).toContain("Axis change not offered");
    // Fail-closed and never disabled: a disabled button asserts the act exists.
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("names the daemon's reason when the roster read behind the axes refused", () => {
    // One arm carried all four roster phases and said the row "has not been read",
    // which is false for a read that ANSWERED and drops the reason it answered with.
    const { container } = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={{ ...NOTHING_ASKED, phase: "refused" }}
        axes={{
          reach: "refused",
          refusal: {
            code: "reply-unreadable",
            detail: "The roster reply did not parse.",
            origin: "growth-port",
          },
        }}
      />,
    );

    expect(container.textContent).toContain("reply-unreadable");
    expect(container.textContent).toContain("did not parse");
    // The negative control on the sentence this arm replaced.
    expect(container.textContent).not.toContain("roster row has not been read");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("separates a travelling read, an unasked one, and a roster holding no such agent", () => {
    const phrases = (["loading", "not-checked", "no-such-agent"] as const).map((reach) => {
      const { container } = render(
        <TargetChip
          model={{ target: RUN_TARGET, bindingClause: undefined }}
          binding={NOTHING_ASKED}
          axes={{ reach }}
        />,
      );
      return container.textContent ?? "";
    });

    // The badge shape carries its second line as a tooltip, so what a reader MEETS
    // is the title — which is why each arm's title has to differ, not just its
    // detail. The unreachable arm's own words are asserted in the case above.
    expect(phrases[0]).toContain("Reading this agent's axes");
    expect(phrases[1]).toContain("Axes not read");
    expect(phrases[2]).toContain("Agent not on the roster");
    // The negative control, and the whole of the finding: three states that read the
    // same are one state with three names.
    expect(new Set(phrases).size).toBe(3);
    expect(phrases.some((phrase) => phrase.includes("Axis change not offered"))).toBe(false);
  });

  it("carries the axis mutation's own refusal, which no popover is holding", () => {
    // The refusal reached only the portalled form, which unmounts on a dismissal —
    // so the chip, which is what stays on screen, said nothing about a press the
    // daemon had refused. It is rendered BESIDE a failed settlement, never instead
    // of one: a call that did not land and a daemon that answered "failed" are two
    // facts and neither is reachable from the other.
    const { container } = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={bindingRead()}
        axes={axisReachOffered({
          settled: { settlement: { status: "failed", reason: "account_unavailable" } },
          refusal: {
            code: "read-failed",
            detail: "The daemon refused the move.",
            origin: "agent-mutation",
          },
        })}
      />,
    );
    const text = container.textContent ?? "";

    expect(text).toContain("Axis change not applied");
    expect(text).toContain("read-failed");
    expect(text).toContain("The daemon refused the move.");
    // Rule 4's third clause, which is this console's sentence and not the wire's.
    expect(text).toContain("Open the axis control and submit again");
    // And the settlement beside it, unreplaced.
    expect(text).toContain("Switch failed");
    expect(text).toContain("account_unavailable");
  });

  it("renders an unbuilt wire's refusal as an absence rather than as a failure", () => {
    // The popover is offered when the PORT carries a method, which a live bridge does
    // for a wire the corpus has not registered — so this refusal is reachable on every
    // live build and would otherwise wear an alert glyph for a wire nobody landed.
    const { container } = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={bindingRead()}
        axes={axisReachOffered({
          refusal: {
            code: "wire-unregistered",
            detail: "Not checked — agent.configUpdate is not registered on this build yet.",
            origin: "growth-port",
          },
        })}
      />,
    );

    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.textContent).not.toContain("wire-unregistered");
    expect(container.querySelector(".meridian-chip--failure")).toBeNull();
  });

  it("negative control: a latch that refused nothing puts no refusal on the chip", () => {
    const { container } = render(
      <TargetChip
        model={{ target: RUN_TARGET, bindingClause: undefined }}
        binding={bindingRead()}
        axes={axisReachOffered()}
      />,
    );

    expect(container.textContent).not.toContain("Axis change not applied");
    expect(container.querySelector(".meridian-refusal")).toBeNull();
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
