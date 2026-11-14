// The Agents pane over the daemon: the session's agents name each child the one child-run links
// read returns, laid out as one tree, and a refused read draws the pane's failure line with
// `Try again`, which asks once more. Driven on a fake bridge through the real client, so the
// reply passes the method's generated check.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  AgentChildRunLinkListResponse,
  ChildRunHead,
} from "@ai-sidekicks/contracts/orchestration";
import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { ChildHandle } from "@ai-sidekicks/contracts/agent/tree";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { ManualClock } from "#renderer/lib/clock.js";
import { REFRESH_MAX_WAIT_MS } from "#renderer/lib/reads/refresh/caps.js";
import { readChildRunLinks } from "#renderer/services/daemon/child-run-links.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { agentEntry, agentListAcknowledgment } from "#renderer/store/agents/list.test-support.js";
import { bridgeWrapper, withAnnouncer } from "#test/helpers/app/frame-fixtures.js";
import {
  bridgeOnClock,
  withDaemonCall,
  withDaemonSubscribe,
  type RecordedDaemonCall,
} from "#test/helpers/fixture/bridge.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { initializedStore } from "#test/helpers/session/store/fixtures.js";
import type { AgentsPaneCalls } from "../reads.js";
import { AgentsPane } from "./AgentsPane.js";

const SESSION_ID = "019b7b30-0280-7c3d-8110-cca0117a0180";
const LEAD_RUN = "019b7b30-0280-7bd1-8110-cca0117a0181" as RunId;
const REVIEWER_RUN = "019b7b30-0280-7bd1-8110-cca0117a0182" as RunId;
const SCOUT_RUN = "019b7b30-0280-7bd1-8110-cca0117a0183" as RunId;
const LEAD_ID = "019b7b30-0280-7bd1-8110-cca0117a0184" as AgentId;
const REVIEWER_ID = "019b7b30-0280-7bd1-8110-cca0117a0185" as AgentId;
const SCOUT_ID = "019b7b30-0280-7bd1-8110-cca0117a0186" as AgentId;

const CALLS: AgentsPaneCalls = { readChildRunLinks };

/** What the head of every child here reads, but its model and figures. */
function head(modelId: string, tokens: number, spendUsdMicros: number): ChildRunHead {
  return {
    modelId,
    effort: "high",
    tokens,
    spendUsdMicros,
    startedAt: "2026-01-01T10:06:00.000Z",
    ancestry: [{ kind: "agent", agentId: LEAD_ID }],
  };
}

/**
 * The lead's run dispatched the reviewer, which dispatched the scout as a peer call and a provider
 * helper of its own; the scout's run comes first on the wire, before its parent.
 */
const TREE: AgentChildRunLinkListResponse = {
  children: [
    {
      kind: "run",
      childRunId: SCOUT_RUN,
      parentRunId: REVIEWER_RUN,
      agentId: SCOUT_ID,
      state: "failed",
      head: { ...head("haiku", 1_200, 3_900), viaAgentName: "Reviewer" },
    },
    {
      kind: "run",
      childRunId: REVIEWER_RUN,
      parentRunId: LEAD_RUN,
      agentId: REVIEWER_ID,
      state: "running",
      head: head("opus", 8_400, 39_100),
    },
    {
      kind: "providerChild",
      runId: REVIEWER_RUN,
      childHandle: "helper-1" as ChildHandle,
      state: "completed",
      head: head("sonnet", 500, 0),
    },
  ],
  counts: { live: 1, total: 3, waiting: 0 },
  rejectedCreates: [],
};

/** A bridge answering the child-run links read with `answer` and holding the agent stream open. */
function paneBridge(answer: (call: RecordedDaemonCall) => unknown): {
  readonly bridge: PlatformBridge;
  readonly calls: readonly RecordedDaemonCall[];
  readonly clock: ManualClock;
  readonly deliverAgents: (payload: unknown) => void;
} {
  const clock = new ManualClock();
  const deliveries: ((payload: unknown) => void)[] = [];
  const { bridge: calling, calls } = withDaemonCall(
    bridgeOnClock("agents-pane", clock).bridge,
    async (call, passThrough) =>
      call.method === "agent.childRunLink.list" ? answer(call) : passThrough(),
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
    clock,
    deliverAgents: (payload) => {
      act(() => {
        for (const deliver of deliveries) {
          deliver(payload);
        }
      });
    },
  };
}

/** Let every read armed inside the coalescing window fall due and settle. */
async function settleReads(clock: ManualClock): Promise<void> {
  await act(async () => {
    clock.advance(REFRESH_MAX_WAIT_MS);
    for (let pass = 0; pass < 4; pass += 1) {
      await crossMacrotaskBoundary();
    }
  });
}

function renderPane(bridge: PlatformBridge, clock: ManualClock): void {
  render(
    <AgentsPane
      agentId={undefined}
      bridge={bridge}
      sessionStore={initializedStore(SESSION_ID)}
      calls={CALLS}
    />,
    { wrapper: withAnnouncer(bridgeWrapper(bridge, clock)) },
  );
}

/** Each drawn child row's words, in order. */
function childRowTexts(): readonly string[] {
  const tree = screen.getByRole("group", { name: "Dispatched sidekicks" });
  return [...tree.querySelectorAll("li")].map((row) => row.textContent ?? "");
}

/** How many times the child-run links were asked for. */
function linkReads(calls: readonly RecordedDaemonCall[]): number {
  return calls.filter((call) => call.method === "agent.childRunLink.list").length;
}

describe("the Agents pane's dispatched sidekicks", () => {
  it("lists the session's children as one tree, named by the agent list, from one read", async () => {
    const { bridge, calls, clock, deliverAgents } = paneBridge(() => TREE);
    renderPane(bridge, clock);
    await settleReads(clock);
    deliverAgents(
      agentListAcknowledgment([
        agentEntry(LEAD_ID, "Lead"),
        agentEntry(REVIEWER_ID, "Reviewer"),
        agentEntry(SCOUT_ID, "Scout"),
      ]),
    );

    expect(linkReads(calls)).toBe(1);
    expect(calls.find((call) => call.method === "agent.childRunLink.list")?.params).toStrictEqual({
      sessionId: SESSION_ID,
    });
    // The reviewer first, at the root; the scout and its helper under it, in wire order.
    expect(childRowTexts()).toStrictEqual([
      "Reviewer · opus · high8.4K tokens · $0.0391",
      "Scout · haiku · high via Reviewer✗ failed1.2K tokens · $0.0039",
      "sonnet · high500 tokens · $0.00",
    ]);
    const depths = [
      ...screen.getByRole("group", { name: "Dispatched sidekicks" }).querySelectorAll("li"),
    ].map((row) => row.dataset["depth"]);
    expect(depths).toStrictEqual(["0", "1", "1"]);
  });

  it("draws the failure line on a refused read, and `Try again` reads once more", async () => {
    let isRefusing = true;
    const { bridge, calls, clock } = paneBridge(() => {
      if (isRefusing) {
        throw { code: "session.notFound", message: "That session is gone." };
      }
      return TREE;
    });
    renderPane(bridge, clock);
    await settleReads(clock);

    const tree = screen.getByRole("group", { name: "Dispatched sidekicks" });
    expect(tree.textContent).toBe("Couldn't load sidekicksTry again");
    expect(linkReads(calls)).toBe(1);

    isRefusing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settleReads(clock);

    expect(linkReads(calls)).toBe(2);
    expect(tree.querySelectorAll("li")).toHaveLength(3);
  });
});
