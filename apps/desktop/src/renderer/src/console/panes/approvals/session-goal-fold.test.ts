// The fold's ordering: by origin, never by arrival, and the entry a projection names.
//
// Its own file because ordering is the property the whole fold exists for. Two nodes
// can deliver the same two writes in opposite orders, and a fold that trusted arrival
// would give the two readers different goals for the same session — so the keys the
// fold ranks by are the origin's, and the projection says which entry it read.

import { describe, expect, it } from "vitest";
import { type ConsoleSessionEvent } from "../../store/index.js";
import { foldSessionGoal } from "./session-goal.js";
import {
  event,
  goalClear,
  goalUpdate,
  originGoalClear,
  originGoalUpdate,
  TIED_INSTANT,
} from "./session-goal.test-support.js";

describe("the fold is ordered by origin and not by arrival", () => {
  const NODE_ONE = "node-alpha";
  const NODE_TWO = "node-beta";

  it("keeps the origin's newest append when a delayed one lands after it", () => {
    // Negative control on the local-sequence rank: both events share an instant, so
    // the old fold broke the tie on local position and took the delayed append —
    // the origin's own older goal — as the current one.
    const goal = foldSessionGoal([
      originGoalUpdate(1, "origin append nine", { nodeId: NODE_ONE, originSeq: 9 }, TIED_INSTANT),
      originGoalUpdate(2, "origin append eight", { nodeId: NODE_ONE, originSeq: 8 }, TIED_INSTANT),
    ]);
    expect(goal).toStrictEqual({
      status: "set",
      text: "origin append nine",
      revision: expect.any(String),
    });
  });

  it("keeps the origin's newest append when that origin's clock stepped backward", () => {
    // Within one daemon the append order is authoritative and the wall clock is
    // display data, so a step backward between two serial local mutations must not
    // invert them. The old fold read the instant first and inverted them.
    const goal = foldSessionGoal([
      originGoalUpdate(
        1,
        "appended first",
        { nodeId: NODE_ONE, originSeq: 4 },
        "2026-01-01T00:00:09.000Z",
      ),
      originGoalUpdate(
        2,
        "appended second",
        { nodeId: NODE_ONE, originSeq: 5 },
        "2026-01-01T00:00:01.000Z",
      ),
    ]);
    expect(goal).toStrictEqual({
      status: "set",
      text: "appended second",
      revision: expect.any(String),
    });
  });

  it("compares two origins' winners on the instant, and a clear competes there too", () => {
    const goal = foldSessionGoal([
      originGoalUpdate(
        1,
        "beta is older",
        { nodeId: NODE_TWO, originSeq: 30 },
        "2026-01-01T00:00:01.000Z",
      ),
      originGoalUpdate(
        2,
        "alpha is newer",
        { nodeId: NODE_ONE, originSeq: 2 },
        "2026-01-01T00:00:09.000Z",
      ),
    ]);
    expect(goal).toStrictEqual({
      status: "set",
      text: "alpha is newer",
      revision: expect.any(String),
    });

    const clearWins = foldSessionGoal([
      originGoalUpdate(
        1,
        "alpha set it",
        { nodeId: NODE_ONE, originSeq: 2 },
        "2026-01-01T00:00:01.000Z",
      ),
      originGoalClear(2, { nodeId: NODE_TWO, originSeq: 30 }, "2026-01-01T00:00:09.000Z"),
    ]);
    expect(clearWins).toStrictEqual({ status: "none", revision: expect.any(String) });
  });

  it("settles an identical instant across origins on the envelope id", () => {
    // Two daemons accepted a mutation at the same recorded instant. There is no
    // sequence to compare across origins, so the envelope id decides — the same id
    // on every node, so every node decides the same way. The local positions point
    // the OTHER way here, which is what the old fold ranked on.
    const alpha = {
      ...originGoalUpdate(8, "alpha wrote it", { nodeId: NODE_ONE, originSeq: 1 }, TIED_INSTANT),
      id: "event-aaa",
    };
    const beta = {
      ...originGoalUpdate(2, "beta wrote it", { nodeId: NODE_TWO, originSeq: 1 }, TIED_INSTANT),
      id: "event-zzz",
    };
    expect(alpha.id < beta.id).toBe(true);
    expect(alpha.sequence > beta.sequence).toBe(true);
    expect(foldSessionGoal([alpha, beta])).toStrictEqual({
      status: "set",
      text: "beta wrote it",
      revision: expect.any(String),
    });
    expect(foldSessionGoal([beta, alpha])).toStrictEqual({
      status: "set",
      text: "beta wrote it",
      revision: expect.any(String),
    });
  });

  it("folds a payload carrying no origin keys through the envelope-ordered slot", () => {
    // An event appended before the keys existed cannot join an origin's register.
    // It still competes, on the envelope, rather than being dropped or ranked on
    // where it happened to land here.
    const goal = foldSessionGoal([
      originGoalUpdate(
        1,
        "keyed and older",
        { nodeId: NODE_ONE, originSeq: 7 },
        "2026-01-01T00:00:01.000Z",
      ),
      goalUpdate(2, "unkeyed and newer", "2026-01-01T00:00:09.000Z"),
    ]);
    expect(goal).toStrictEqual({
      status: "set",
      text: "unkeyed and newer",
      revision: expect.any(String),
    });
  });

  it("refuses to read a malformed origin key as an order", () => {
    // A string sequence and an empty node id are not orders. Both events fall to
    // the envelope-ordered slot, so the newer instant wins rather than whichever
    // hand-shaped read happened to compare larger.
    const goal = foldSessionGoal([
      event(
        1,
        "session.goal_updated",
        { goal: { text: "string sequence" }, originNodeId: NODE_ONE, originSeq: "9" },
        "2026-01-01T00:00:09.000Z",
      ),
      event(
        2,
        "session.goal_updated",
        { goal: { text: "empty node id" }, originNodeId: "", originSeq: 3 },
        "2026-01-01T00:00:01.000Z",
      ),
    ]);
    expect(goal).toStrictEqual({
      status: "set",
      text: "string sequence",
      revision: expect.any(String),
    });
  });

  it("agrees with a second node that received the same events in another order", () => {
    // The property the ranking exists for. Each node appends what it receives under
    // its own local positions, so the two timelines share no sequence at all — and
    // still have to answer the same. The old fold answered differently.
    const authored = [
      { text: "alpha first", nodeId: NODE_ONE, originSeq: 1, at: TIED_INSTANT },
      { text: "alpha second", nodeId: NODE_ONE, originSeq: 2, at: TIED_INSTANT },
      { text: "beta only", nodeId: NODE_TWO, originSeq: 1, at: TIED_INSTANT },
    ] as const;
    const arrivalOnThisNode = [authored[0], authored[1], authored[2]];
    const arrivalOnThatNode = [authored[2], authored[1], authored[0]];
    const timelineFor = (arrivals: readonly (typeof authored)[number][]): ConsoleSessionEvent[] =>
      arrivals.map((entry, index) => ({
        // The local position is this node's; the envelope id is the event's own and
        // is the same wherever it lands, which is why the comparator may use it.
        ...originGoalUpdate(
          index + 1,
          entry.text,
          { nodeId: entry.nodeId, originSeq: entry.originSeq },
          entry.at,
        ),
        id: `event-${entry.nodeId}-${String(entry.originSeq)}`,
      }));
    const here = foldSessionGoal(timelineFor(arrivalOnThisNode));
    const there = foldSessionGoal(timelineFor(arrivalOnThatNode));
    // Alpha's register settles on its own second append; beta's on its only one;
    // the tied instant between those two winners settles on the envelope id.
    expect(here).toStrictEqual({ status: "set", text: "beta only", revision: expect.any(String) });
    expect(there).toStrictEqual(here);
  });
});

// The projection's REVISION: which log entry it was read from. The fold runs over
// the whole timeline, so it answers with a fresh object on every beat of any kind —
// and a consumer that keys on the object rather than on this member acts on a goal
// change once per event the session ever carries.

describe("the projection names the entry it was read from", () => {
  it("holds the revision across events that are not goal events", () => {
    const beforeTheBeats = foldSessionGoal([goalUpdate(1, "ship it")]);
    const afterTheBeats = foldSessionGoal([
      goalUpdate(1, "ship it"),
      event(2, "usage.token_count"),
      event(3, "run.turn_started"),
    ]);
    expect(afterTheBeats).toStrictEqual(beforeTheBeats);
  });

  it("moves the revision when a further goal update wins", () => {
    const first = foldSessionGoal([goalUpdate(1, "ship it")]);
    const second = foldSessionGoal([goalUpdate(1, "ship it"), goalUpdate(2, "ship it twice")]);
    expect(second.revision).not.toBe(first.revision);
  });

  it("moves the revision when the goal is re-set to the text it already had", () => {
    // A participant setting the same words again is still an act, and a consumer
    // told nothing changed would go on showing whatever it had open. This is the
    // case a text comparison gets wrong and an identity does not.
    const first = foldSessionGoal([goalUpdate(1, "ship it")]);
    const again = foldSessionGoal([goalUpdate(1, "ship it"), goalUpdate(2, "ship it")]);
    expect(again).toStrictEqual({ status: "set", text: "ship it", revision: expect.any(String) });
    expect(again.revision).not.toBe(first.revision);
  });

  it("moves the revision when a clear wins", () => {
    const set = foldSessionGoal([goalUpdate(1, "ship it", "2026-01-01T00:00:00.000Z")]);
    const cleared = foldSessionGoal([
      goalUpdate(1, "ship it", "2026-01-01T00:00:00.000Z"),
      goalClear(2, "2026-01-01T00:00:01.000Z"),
    ]);
    expect(cleared.status).toBe("none");
    expect(cleared.revision).not.toBe(set.revision);
  });

  it("keys an origin-stamped winner on its origin pair, so two nodes agree", () => {
    const origin = { nodeId: "node-alpha", originSeq: 9 };
    const here = foldSessionGoal([originGoalUpdate(1, "stamped", origin)]);
    // The same authored event, landed at a different local position and carrying a
    // different envelope id, is the same reading — which is what a revision derived
    // from arrival could not say.
    const there = foldSessionGoal([
      { ...originGoalUpdate(7, "stamped", origin), id: "event-elsewhere" },
    ]);
    expect(there.revision).toBe(here.revision);
  });

  it("names a session with no goal event at all, distinctly from every event's", () => {
    const never = foldSessionGoal([event(1, "run.queued")]);
    const cleared = foldSessionGoal([goalClear(1)]);
    expect(never.status).toBe("none");
    expect(cleared.status).toBe("none");
    // Both read "no goal", and they are not the same reading: one session has never
    // had one and the other has had one taken away.
    expect(never.revision).not.toBe(cleared.revision);
  });

  it("negative control: an unrelated beat does move the projection OBJECT", () => {
    // The defect this member exists for. Without it there is nothing stable to key
    // on, and this is the assertion that fails the moment the fold starts returning
    // the same object for a timeline that grew.
    const first = foldSessionGoal([goalUpdate(1, "ship it")]);
    const second = foldSessionGoal([goalUpdate(1, "ship it"), event(2, "usage.token_count")]);
    expect(second).not.toBe(first);
    expect(second.revision).toBe(first.revision);
  });
});
