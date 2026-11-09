// A running command's hold, named by its run's agent: the session store's run names the agent and
// the session's agent list names it, the line reads `<agent>'s running command holds the shell.`
// beside `Stop the run` and no take, and the stop is the holding command's. Until the list has
// delivered that agent the line draws nothing, never a name it made up. Driven on a fake bridge,
// so it carries no scenario.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import type { CommandId } from "@ai-sidekicks/contracts/command";
import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TerminalId } from "@ai-sidekicks/contracts/terminal";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { StandingContent } from "#renderer/components/LiveAnnouncer/StandingContent.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { agentEntry, agentListAcknowledgment } from "#renderer/store/agents/list.test-support.js";
import { RUN_LIFECYCLE_PROJECTORS } from "#renderer/store/session/events/run/lifecycle-projector.js";
import { RUN_QUEUED_EVENT_KIND } from "#renderer/store/session/events/run/state-kinds.js";
import { SessionStore } from "#renderer/store/session/store.js";
import {
  bridgeOnClock,
  withDaemonCall,
  withDaemonSubscribe,
} from "#test/helpers/fixture/bridge.js";
import { drawnText } from "#test/helpers/live-region.js";
import { spiedAnnouncer } from "#test/helpers/spied-announcer.js";
import { eventOfKind } from "#test/helpers/session/events.js";
import { emptyBaseState } from "#test/helpers/session/store/fixtures.js";
import { useStopRun } from "../hooks/useStopRun.js";
import { useTakeShell } from "../hooks/useTakeShell.js";
import { UNREAD_TERMINAL_LEASE, type TerminalLeaseState } from "../state.js";
import { LeaseLine } from "./LeaseLine.js";

const SESSION_ID = "019b7b30-0280-7c3d-8110-cca0117a0170" as SessionId;
const RUN_ID = "019b7b30-0280-7bd1-8110-cca0117a0171" as RunId;
const AGENT_ID = "019b7b30-0280-7bd1-8110-cca0117a0172";
const COMMAND_ID = "command-1" as CommandId;

/** The run's hold, its machine this device's, as the fold reads it. */
const HELD_BY_A_RUN: TerminalLeaseState = {
  ...UNREAD_TERMINAL_LEASE,
  holder: "held-by-run",
  holderDeviceId: "019b7b30-0280-79a4-8110-cca0117a0173" as DeviceId,
  holderRunId: RUN_ID,
  holderCommandId: COMMAND_ID,
};

/** A bridge recording each daemon call and handing the case the agent stream's delivery. */
function runHoldBridge(): {
  readonly bridge: PlatformBridge;
  readonly calls: readonly { readonly method: string; readonly params: unknown }[];
  readonly deliverAgents: (payload: unknown) => void;
} {
  const deliveries: ((payload: unknown) => void)[] = [];
  const { bridge: calling, calls } = withDaemonCall(
    bridgeOnClock("lease-run-hold").bridge,
    async (call, passThrough) =>
      call.method === "agent.command.stop"
        ? { commandId: COMMAND_ID, stopped: true }
        : passThrough(),
  );
  const bridge = withDaemonSubscribe(calling, (passThrough, handler, _request, _onEnded, event) => {
    if (event !== "agent.subscribe") {
      return passThrough();
    }
    deliveries.push(handler);
    return () => undefined;
  });
  return {
    bridge,
    calls,
    deliverAgents: (payload) => {
      act(() => {
        for (const deliver of deliveries) {
          deliver(payload);
        }
      });
    },
  };
}

/** A session projecting its runs, whose run was queued for the agent. */
function sessionWithQueuedRun(): SessionStore {
  const sessionStore = new SessionStore({
    sessionId: SESSION_ID,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  sessionStore.initialize(emptyBaseState(0));
  sessionStore.apply(
    eventOfKind(SESSION_ID, RUN_QUEUED_EVENT_KIND, 1, {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      runVersion: 1,
      newState: "queued",
      agentId: AGENT_ID,
    }),
  );
  return sessionStore;
}

function RunHeldLeaseLine(props: {
  readonly bridge: PlatformBridge;
  readonly sessionStore: SessionStore;
}): React.JSX.Element {
  const [target] = useState(() => ({
    sessionId: SESSION_ID,
    terminalId: "shell-1" as TerminalId,
    outputSubscriptionId: "019b7b30-0280-7c3d-8110-cca0117a0174" as SubscriptionId,
  }));
  const takeShell = useTakeShell(props.bridge, target, HELD_BY_A_RUN.holderDeviceId);
  const stopRun = useStopRun(props.bridge, SESSION_ID, HELD_BY_A_RUN.holderCommandId);
  return (
    <LeaseLine
      bridge={props.bridge}
      sessionStore={props.sessionStore}
      state={HELD_BY_A_RUN}
      deviceName={undefined}
      takeShell={takeShell}
      stopRun={stopRun}
    />
  );
}

describe("a running command's hold", () => {
  it("names the run's agent beside `Stop the run` once the agent list delivers it, and stops the holding command", async () => {
    const { bridge, calls, deliverAgents } = runHoldBridge();
    const said = spiedAnnouncer();
    const { container } = render(
      <RunHeldLeaseLine bridge={bridge} sessionStore={sessionWithQueuedRun()} />,
      {
        wrapper: ({ children }) => (
          <LiveAnnouncerProvider announcer={said.announcer}>
            <StandingContent>{children}</StandingContent>
          </LiveAnnouncerProvider>
        ),
      },
    );

    // The run names its agent, but the list has not delivered it: no name, so no line.
    expect(drawnText(container)).toBe("");
    deliverAgents(agentListAcknowledgment([agentEntry(AGENT_ID, "Reviewer")]));

    expect(screen.getByRole("group", { name: "Terminal lease" }).textContent).toBe(
      "Reviewer's running command holds the shell.Stop the run",
    );
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toStrictEqual([
      "Stop the run",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Stop the run" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls.filter((call) => call.method === "agent.command.stop")).toStrictEqual([
      { method: "agent.command.stop", params: { sessionId: SESSION_ID, commandId: COMMAND_ID } },
    ]);
  });
});
