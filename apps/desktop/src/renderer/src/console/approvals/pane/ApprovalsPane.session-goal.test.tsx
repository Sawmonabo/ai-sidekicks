// The session goal, as the approvals pane renders it.
//
// Its own file on the precedent beside it: the goal is a section this pane hosts
// rather than one of its two reads, with its own authority rule — who may set one —
// and its own draft. Reading it out of the pane's own suite made two subjects share
// one file and one setup.

import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalsPane } from "./ApprovalsPane.js";
import { createFixtureBridge } from "../../bridge/index.js";
import { APPROVALS_SCENARIO } from "../../bridge/scenarios/approvals.js";
import { type ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { drainMicrotasks } from "../../bridge/fixture/fixture-bridge.test-support.js";
import {
  approvalsPaneContext,
  boundStore,
  mountPane,
  settle,
} from "./approvals-pane.test-support.js";

describe("the session goal", () => {
  it("offers the control to the owner this window is", async () => {
    // The scenario says which participant this window is and the store's roster
    // says that participant is an owner, so the goal contract's own eligibility
    // resolves — rather than every caller being pinned in the unknown-role arm.
    const bridge = await mountPane();
    await settle(bridge);
    const goal = screen.getByRole("region", { name: "Session goal" });
    expect(within(goal).getByText("No goal set")).not.toBeNull();
    expect(within(goal).getByRole("button", { name: "Set a goal" })).not.toBeNull();
  });

  it("offers no control to a viewer, and says nothing about a refusal", async () => {
    const viewerScenario: ConsoleScenario = {
      ...APPROVALS_SCENARIO,
      membershipRoleByParticipantId: {
        ...APPROVALS_SCENARIO.membershipRoleByParticipantId,
        ...(APPROVALS_SCENARIO.viewingParticipantId === undefined
          ? {}
          : { [APPROVALS_SCENARIO.viewingParticipantId]: "viewer" as const }),
      },
    };
    const bridge = await mountPane(viewerScenario);
    await settle(bridge);
    const goal = screen.getByRole("region", { name: "Session goal" });
    expect(within(goal).getByText("No goal set")).not.toBeNull();
    expect(within(goal).queryByRole("button")).toBeNull();
  });

  it("holds the unknown-role arm while the identity read is in flight", async () => {
    // Before the read settles the role is not known, and an unknown role is
    // treated exactly as read-only. Asserted on the first commit rather than after
    // the drain, which is the interval a hook that kept a previous answer would
    // have rendered a control in.
    const bridge = createFixtureBridge({ scenario: APPROVALS_SCENARIO });
    render(<ApprovalsPane {...approvalsPaneContext(bridge, boundStore())} />);
    const goal = screen.getByRole("region", { name: "Session goal" });
    expect(within(goal).queryByRole("button")).toBeNull();
    await act(async () => {
      await drainMicrotasks();
    });
  });

  it("says why the control is missing when the identity read refuses", async () => {
    // A scenario naming no viewer leaves the question unasked rather than answered
    // emptily, so the fixture refuses it — and the card renders that refusal's own
    // code instead of looking read-only for no stated reason.
    const { viewingParticipantId, ...anonymousScenario } = APPROVALS_SCENARIO;
    expect(viewingParticipantId).not.toBeUndefined();
    const bridge = await mountPane(anonymousScenario);
    await settle(bridge);
    const goal = screen.getByRole("region", { name: "Session goal" });
    expect(within(goal).queryByRole("button")).toBeNull();
    expect(within(goal).getByText("wire-unregistered")).not.toBeNull();
  });

  it("negative control: the control is not offered to everyone", async () => {
    // Without this, a card wired to a constant `true` would pass the owner case
    // above and hand a viewer the same controls.
    const viewerScenario: ConsoleScenario = {
      ...APPROVALS_SCENARIO,
      membershipRoleByParticipantId: {
        ...APPROVALS_SCENARIO.membershipRoleByParticipantId,
        ...(APPROVALS_SCENARIO.viewingParticipantId === undefined
          ? {}
          : { [APPROVALS_SCENARIO.viewingParticipantId]: "runtime contributor" as const }),
      },
    };
    const bridge = await mountPane(viewerScenario);
    await settle(bridge);
    const goal = screen.getByRole("region", { name: "Session goal" });
    expect(within(goal).queryByRole("button", { name: "Set a goal" })).toBeNull();
  });
});
