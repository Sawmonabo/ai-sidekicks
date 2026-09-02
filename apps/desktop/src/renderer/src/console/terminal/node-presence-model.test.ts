// The presence fold, and the one question it is allowed to answer.
//
// Two claims, and the second is the one worth the file. The FOLD is last-write-wins
// over the log, so the newest thing said about a host is what the host reads as —
// including when the newest thing is a state this build cannot place. The
// RESOLUTION is deliberately narrow: it answers only where the session has exactly
// one attached node, because the wire carries no link from a lease holder to the
// machine it sits on, and every case below that would pass against an
// implementation that guessed has a control that fails against one.

import { describe, expect, it } from "vitest";

import { TERMINAL_HOST_NODE_ID } from "../bridge/scenarios/terminal-cast.js";
import type { ConsoleSessionEvent } from "../store/index.js";
import { projectNodePresence, resolveSoleHoldingNode } from "./node-presence-model.js";

/** The session's host, read off the scenario rather than written down here. */
const HOST_NODE_ID = TERMINAL_HOST_NODE_ID;
const SECOND_NODE_ID = "node-laptop";

function presenceEvent(
  sequence: number,
  kind: string,
  payload: Readonly<Record<string, unknown>> | undefined,
): ConsoleSessionEvent {
  return {
    // Readable rather than UUID-shaped, as the substrate's own fold suites spell it
    // (`store/failure-modes.test-support.ts`): the presence fold reads this member
    // for nothing, and every id it does render comes off the scenario's cast.
    id: `event-${String(sequence)}`,
    sessionId: "session-terminal",
    sequence,
    kind,
    occurredAt: `2026-01-01T16:40:0${String(sequence % 10)}.000Z`,
    ...(payload === undefined ? {} : { payload }),
  };
}

function lifecycleEvent(sequence: number, kind: string, nodeId: string, newState: unknown) {
  return presenceEvent(sequence, kind, { nodeId, newState });
}

describe("the presence fold — the newest thing the log said about a host", () => {
  it("reads a host that went offline as unreachable", () => {
    expect(
      projectNodePresence([
        lifecycleEvent(1, "runtime_node.online", HOST_NODE_ID, "online"),
        lifecycleEvent(2, "runtime_node.offline", HOST_NODE_ID, "offline"),
      ]),
    ).toStrictEqual([{ nodeId: HOST_NODE_ID, reachability: "unreachable" }]);
  });

  it("reads a host that came back as reachable", () => {
    // The same two events in the other order. Without this the case above would
    // pass against a fold that answered `unreachable` the moment it ever saw one.
    expect(
      projectNodePresence([
        lifecycleEvent(1, "runtime_node.offline", HOST_NODE_ID, "offline"),
        lifecycleEvent(2, "runtime_node.online", HOST_NODE_ID, "online"),
      ]),
    ).toStrictEqual([{ nodeId: HOST_NODE_ID, reachability: "reachable" }]);
  });

  it("keeps two hosts apart rather than folding them into one reading", () => {
    expect(
      projectNodePresence([
        lifecycleEvent(1, "runtime_node.online", HOST_NODE_ID, "online"),
        lifecycleEvent(2, "runtime_node.registered", SECOND_NODE_ID, "registering"),
        lifecycleEvent(3, "runtime_node.offline", HOST_NODE_ID, "offline"),
      ]),
    ).toStrictEqual([
      { nodeId: HOST_NODE_ID, reachability: "unreachable" },
      { nodeId: SECOND_NODE_ID, reachability: "unknown" },
    ]);
  });

  it("reads a log with no presence event at all as knowing no host", () => {
    expect(
      projectNodePresence([
        presenceEvent(1, "pty.control_changed", { holderParticipantId: null, reason: "released" }),
        presenceEvent(2, "run.completed", { newState: "completed" }),
      ]),
    ).toStrictEqual([]);
  });

  it("records a state this build cannot place as unknown rather than as reachable", () => {
    // The direction that matters: a fold that fell back to the last state it DID
    // understand would leave a host reading reachable after the wire said something
    // newer that this build could not read.
    expect(
      projectNodePresence([
        lifecycleEvent(1, "runtime_node.online", HOST_NODE_ID, "online"),
        lifecycleEvent(2, "runtime_node.quarantined", HOST_NODE_ID, "quarantined"),
      ]),
    ).toStrictEqual([{ nodeId: HOST_NODE_ID, reachability: "unknown" }]);
  });

  it("skips a runtime-node event that reports no state and one that names no node", () => {
    // A capability declaration is not a liveness reading, and a payload with no
    // node has nothing to key on. Neither may move or invent an entry.
    expect(
      projectNodePresence([
        presenceEvent(1, "runtime_node.capability_declared", {
          nodeId: HOST_NODE_ID,
          capabilityKey: "provider-driver",
        }),
        presenceEvent(2, "runtime_node.online", { newState: "online" }),
        presenceEvent(3, "runtime_node.offline", undefined),
      ]),
    ).toStrictEqual([]);
  });
});

describe("resolving a holding node — one host, or no answer", () => {
  it("answers for the single host the session attached", () => {
    expect(
      resolveSoleHoldingNode([{ nodeId: HOST_NODE_ID, reachability: "unreachable" }]),
    ).toStrictEqual({ nodeId: HOST_NODE_ID, isReachable: false });
  });

  it("answers reachable for the single host that is still reporting", () => {
    expect(
      resolveSoleHoldingNode([{ nodeId: HOST_NODE_ID, reachability: "reachable" }]),
    ).toStrictEqual({ nodeId: HOST_NODE_ID, isReachable: true });
  });

  it("refuses to pick between two hosts, because the wire links neither to a holder", () => {
    expect(
      resolveSoleHoldingNode([
        { nodeId: HOST_NODE_ID, reachability: "unreachable" },
        { nodeId: SECOND_NODE_ID, reachability: "reachable" },
      ]),
    ).toBeUndefined();
  });

  it("refuses when the log knows no host at all", () => {
    expect(resolveSoleHoldingNode([])).toBeUndefined();
  });

  it("refuses for a single host whose newest state it could not place", () => {
    // `unknown` is not `unreachable`: collapsing a lease on a state nobody
    // understood would be the fold guessing in the other direction.
    expect(
      resolveSoleHoldingNode([{ nodeId: HOST_NODE_ID, reachability: "unknown" }]),
    ).toBeUndefined();
  });
});
