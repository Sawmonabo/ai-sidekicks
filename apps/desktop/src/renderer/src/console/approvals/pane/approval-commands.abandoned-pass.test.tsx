// A registered approvals row answers through the render that is ON SCREEN.
//
// The rows are memoised on what they SAY, so everything that moves underneath them —
// the pending records, the two dispatchers, whether a goal may be cleared — is read
// through a ref when a person presses Enter. That makes WHERE the ref is written the
// whole safety property: a pass React discards has already run this hook, and a pass
// discarded while the pane was being re-addressed to another session carries that
// session's `resolve`. If the discarded pass could write the ref, the row still on
// screen would answer somebody else's approval request.
//
// Driven through a real transition that suspends rather than described, and asserted
// while the pass is still abandoned: a case that let the tree recover first would pass
// over the defect, because the recovering render writes the committed value back.

import { render } from "@testing-library/react";
import { useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { type ApprovalRecord, type SessionGoalProjection } from "../../bridge/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import { consoleCommands } from "../../palette/index.js";
import {
  SuspendsWhenAsked,
  abandonOneRenderPass,
} from "../../primitives/abandoned-pass.test-support.js";
import { useApprovalCommands, type ApprovalCommandInput } from "./approval-commands.js";
import { type ApprovalResolveRequest } from "./approvals-wire.js";

const PENDING_REQUEST = "3f6b1c2d-4e5f-4061-8273-9a4b5c6d7e8f";
const APPROVE_COMMAND_ID = `approvals.approve.${PENDING_REQUEST}`;
const NO_GOAL: SessionGoalProjection = { status: "none", revision: "1" };

/** The one waiting record both renders offer an answer for. */
function pendingRecord(): ApprovalRecord {
  return {
    approvalRequestId: PENDING_REQUEST,
    runId: "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061",
    category: "file_write",
    state: "pending",
    requestedBy: "agent-ada",
    requestedScope: "session",
    resourceDescriptor: { path: "src/index.ts" },
    createdAt: "2026-09-02T09:00:00.000Z",
    updatedAt: "2026-09-02T09:00:00.000Z",
  };
}

function inputResolvingThrough(
  resolve: (request: ApprovalResolveRequest) => void,
): ApprovalCommandInput {
  return {
    pending: [pendingRecord()],
    resolvingApprovalIds: new Set<string>(),
    resolveRefusalByApprovalId: new Map<string, ConsoleRefusal>(),
    resolve,
    goal: NO_GOAL,
    canMutateGoal: false,
    isMutatingGoal: false,
    clearGoal: () => undefined,
  };
}

/**
 * The hook under a tree that can re-address and suspend in one transition.
 *
 * The two dispatchers are the case's, handed in as props: what the assertion needs is
 * which of them the registered row reached, and a callback minted inside the tree
 * would be a fresh identity on every pass rather than two distinguishable ones.
 */
function ApprovalCommandsHost(props: {
  readonly committedResolve: (request: ApprovalResolveRequest) => void;
  readonly abandonedResolve: (request: ApprovalResolveRequest) => void;
  readonly readdress: { current: (() => void) | undefined };
}): React.JSX.Element {
  const [addressedToAbandoned, setAddressedToAbandoned] = useState(false);
  const [suspend, setSuspend] = useState(false);
  const input = useMemo(
    () =>
      inputResolvingThrough(addressedToAbandoned ? props.abandonedResolve : props.committedResolve),
    [addressedToAbandoned, props.abandonedResolve, props.committedResolve],
  );
  useApprovalCommands(input);
  props.readdress.current = () => {
    setAddressedToAbandoned(true);
    setSuspend(true);
  };
  return <SuspendsWhenAsked suspend={suspend} />;
}

describe("the approvals palette rows answer through the committed render", () => {
  it("resolves through the on-screen render's dispatcher after a discarded re-address", async () => {
    const committedResolve = vi.fn();
    const abandonedResolve = vi.fn();
    const readdress: { current: (() => void) | undefined } = { current: undefined };
    render(
      <ApprovalCommandsHost
        committedResolve={committedResolve}
        abandonedResolve={abandonedResolve}
        readdress={readdress}
      />,
    );

    await abandonOneRenderPass(() => {
      readdress.current?.();
    });
    consoleCommands.get(APPROVE_COMMAND_ID)?.run();

    // The row is the one the committed render contributed, and the discarded pass
    // must have moved nothing it reads. The rows say the same thing in both passes,
    // so the command object itself never changed — only what it dispatches through.
    expect(abandonedResolve).not.toHaveBeenCalled();
    expect(committedResolve).toHaveBeenCalledTimes(1);
    expect(committedResolve.mock.calls[0]?.[0]).toStrictEqual({
      approvalRequestId: PENDING_REQUEST,
      decision: "approved",
      effectiveScope: "session",
    });
  });

  it("negative control: a committed re-address DOES move the row onto the new dispatcher", async () => {
    // Without this the case above would pass over a hook that ignored its input
    // entirely, or over a driver whose transition never re-ran this component at all.
    const committedResolve = vi.fn();
    const laterResolve = vi.fn();
    const readdress: { current: (() => void) | undefined } = { current: undefined };
    const { rerender } = render(
      <ApprovalCommandsHost
        committedResolve={committedResolve}
        abandonedResolve={laterResolve}
        readdress={readdress}
      />,
    );

    // The same re-address, committed rather than abandoned: no transition and no
    // suspension, so React keeps the pass.
    rerender(
      <ApprovalCommandsHost
        committedResolve={laterResolve}
        abandonedResolve={laterResolve}
        readdress={readdress}
      />,
    );
    consoleCommands.get(APPROVE_COMMAND_ID)?.run();

    expect(committedResolve).not.toHaveBeenCalled();
    expect(laterResolve).toHaveBeenCalledTimes(1);
  });
});
