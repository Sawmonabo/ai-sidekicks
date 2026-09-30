// A registered approvals row answers through the render that is ON SCREEN.
//
// The rows are memoized on what they SAY, so everything that moves underneath them —
// the pending records and the two dispatchers — is read through a ref when a person
// presses Enter. That makes WHERE the ref is written the whole safety property: a
// pass React discards has already run this hook, and a pass discarded while the pane
// was being re-addressed to another session carries that session's `resolve`. If the
// discarded pass could write the ref, the row still on screen would answer somebody
// else's approval request.
//
// Driven through a real transition that suspends rather than described, and asserted
// while the pass is still abandoned: a case that let the tree recover first would pass
// over the defect, because the recovering render writes the committed value back.

import { render } from "@testing-library/react";
import { useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ApprovalResolveRequest } from "@ai-sidekicks/contracts";

import { type Refusal } from "@renderer/lib/refusal.js";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { SuspendsWhenAsked, abandonOneRenderPass } from "@test/helpers/abandoned-pass.js";
import { PENDING_APPROVAL_ID, pendingRecord } from "../approval-record.test-support.js";
import { type ApprovalCommandInput } from "../contributions/approval-commands.js";
import { useApprovalCommands } from "./useApprovalCommands.js";

const APPROVE_COMMAND_ID = `approvals.approve.${PENDING_APPROVAL_ID}`;

function inputResolvingThrough(
  resolve: (request: ApprovalResolveRequest) => void,
): ApprovalCommandInput {
  return {
    pending: [pendingRecord()],
    resolvingApprovalIds: new Set<string>(),
    resolveRefusalByApprovalId: new Map<string, Refusal>(),
    resolve,
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
    commandRegistry.get(APPROVE_COMMAND_ID)?.run();

    // The row is the one the committed render contributed, and the discarded pass
    // must have moved nothing it reads. The rows say the same thing in both passes,
    // so the command object itself never changed — only what it dispatches through.
    expect(abandonedResolve).not.toHaveBeenCalled();
    expect(committedResolve).toHaveBeenCalledTimes(1);
    expect(committedResolve.mock.calls[0]?.[0]).toStrictEqual({
      approvalRequestId: PENDING_APPROVAL_ID,
      decision: "approved",
      clientResolutionId: expect.any(String),
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
    commandRegistry.get(APPROVE_COMMAND_ID)?.run();

    expect(committedResolve).not.toHaveBeenCalled();
    expect(laterResolve).toHaveBeenCalledTimes(1);
  });
});
