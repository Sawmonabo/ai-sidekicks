// A registered approvals row answers through the render that is on screen. The rows read the
// records and dispatchers through a ref, so a discarded pass re-addressed to another session must
// not write it. Asserted while the pass is still abandoned: a recovering render would write the
// committed value back and hide the defect.

import { render } from "@testing-library/react";
import { useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ApprovalResolveRequest } from "@ai-sidekicks/contracts/approval";

import { type Refusal } from "#renderer/lib/refusal/refusal.js";
import { commandRegistry } from "#renderer/registries/commands/window-command-registry.js";
import { SuspendsWhenAsked, abandonOneRenderPass } from "#test/helpers/abandoned-pass.js";
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
 * The hook under a tree that can re-address and suspend in one transition. The dispatchers are
 * props so the assertion can tell which one the registered row reached.
 */
function ApprovalCommandsHarness(props: {
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
  it("resolves through the on-screen dispatcher after a discarded re-address", async () => {
    const committedResolve = vi.fn();
    const abandonedResolve = vi.fn();
    const readdress: { current: (() => void) | undefined } = { current: undefined };
    render(
      <ApprovalCommandsHarness
        committedResolve={committedResolve}
        abandonedResolve={abandonedResolve}
        readdress={readdress}
      />,
    );

    await abandonOneRenderPass(() => {
      readdress.current?.();
    });
    commandRegistry.get(APPROVE_COMMAND_ID)?.run();

    // The rows say the same thing in both passes, so the command object never changed, only
    // what it dispatches through.
    expect(abandonedResolve).not.toHaveBeenCalled();
    expect(committedResolve).toHaveBeenCalledTimes(1);
    expect(committedResolve.mock.calls[0]?.[0]).toStrictEqual({
      approvalRequestId: PENDING_APPROVAL_ID,
      decision: "approved",
      clientResolutionId: expect.any(String),
    });
  });

  it("negative control: a committed re-address moves the row to the new dispatcher", async () => {
    // Without this the case above would pass over a hook that ignored its input.
    const committedResolve = vi.fn();
    const laterResolve = vi.fn();
    const readdress: { current: (() => void) | undefined } = { current: undefined };
    const { rerender } = render(
      <ApprovalCommandsHarness
        committedResolve={committedResolve}
        abandonedResolve={laterResolve}
        readdress={readdress}
      />,
    );

    // The same re-address, committed rather than abandoned.
    rerender(
      <ApprovalCommandsHarness
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
