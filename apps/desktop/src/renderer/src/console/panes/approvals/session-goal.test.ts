// The goal's two operations, its bound, and the fold that answers what it is now.
//
// The fold is the interesting half. The goal is a projection of the log rather than
// a stored value, so "what is the goal" has exactly one right answer — whatever the
// event AUTHORED last says — and four ways to get it wrong: read the first event
// instead of the newest, take the newest local position instead of the newest
// reading, treat a clear as an update, or read a malformed payload as an empty
// goal. One case each below, plus the cross-node cases: a delayed same-origin event
// that must not displace a newer origin append, two origins tying on the instant, a
// stamp that does not parse, and the property the whole ranking exists for — two
// nodes handed the same events in different arrival orders answering the same.

import { describe, expect, it } from "vitest";

import { type ConsoleSessionEvent } from "../../store/index.js";
import { SESSION_GOAL_EVENT_KINDS, foldSessionGoal } from "./session-goal.js";

/**
 * One timeline entry.
 *
 * `occurredAt` defaults to a single instant so the cases that are only about kind
 * and payload say nothing about time; the cross-node cases pass their own, which is
 * the whole point of those cases.
 */
function event(
  sequence: number,
  kind: string,
  payload?: Readonly<Record<string, unknown>>,
  occurredAt = "2026-01-01T00:00:00.000Z",
): ConsoleSessionEvent {
  return {
    // The event's own identifier, composed from the position so two rows of one
    // session never share one.
    id: `event-${String(sequence)}`,
    sessionId: "session-one",
    sequence,
    kind,
    occurredAt,
    ...(payload === undefined ? {} : { payload }),
  };
}

function goalUpdate(sequence: number, text: string, occurredAt?: string): ConsoleSessionEvent {
  return event(sequence, "session.goal_updated", { goal: { text } }, occurredAt);
}

function goalClear(sequence: number, occurredAt?: string): ConsoleSessionEvent {
  return event(sequence, "session.goal_cleared", undefined, occurredAt);
}

/**
 * A goal update carrying the origin keys the accepting daemon stamps on it.
 *
 * `localSequence` is where the event landed on THIS node and `originSeq` is where
 * the origin appended it — the two are independent, which is the entire subject of
 * the cross-node cases below.
 */
function originGoalUpdate(
  localSequence: number,
  text: string,
  origin: { readonly nodeId: string; readonly originSeq: number },
  occurredAt?: string,
): ConsoleSessionEvent {
  return event(
    localSequence,
    "session.goal_updated",
    { goal: { text }, originNodeId: origin.nodeId, originSeq: origin.originSeq },
    occurredAt,
  );
}

/** The clearing arm with its own origin keys — the taxonomy stamps both kinds. */
function originGoalClear(
  localSequence: number,
  origin: { readonly nodeId: string; readonly originSeq: number },
  occurredAt?: string,
): ConsoleSessionEvent {
  return event(
    localSequence,
    "session.goal_cleared",
    { originNodeId: origin.nodeId, originSeq: origin.originSeq },
    occurredAt,
  );
}

describe("two operations, never one", () => {
  it("names a distinct method for setting and for clearing", () => {
    expect("session.goalUpdate").toBe("session.goalUpdate");
    expect("session.goalClear").toBe("session.goalClear");
    expect("session.goalUpdate").not.toBe("session.goalClear");
  });

  it("watches exactly the two projection sources", () => {
    expect([...SESSION_GOAL_EVENT_KINDS]).toStrictEqual([
      "session.goal_updated",
      "session.goal_cleared",
    ]);
  });
});

describe("the fold answers what the log says", () => {
  it("takes the latest update and not the first", () => {
    const goal = foldSessionGoal([
      goalUpdate(1, "first goal"),
      event(2, "run.queued"),
      goalUpdate(3, "second goal"),
    ]);
    expect(goal).toStrictEqual({
      status: "set",
      text: "second goal",
      revision: expect.any(String),
    });
  });

  it("treats a later clear as a clear rather than as an absent update", () => {
    const goal = foldSessionGoal([
      goalUpdate(1, "first goal", "2026-01-01T00:00:00.000Z"),
      goalClear(2, "2026-01-01T00:00:01.000Z"),
    ]);
    expect(goal).toStrictEqual({ status: "none", revision: expect.any(String) });
  });

  it("reports an unreadable goal event rather than reading it as no goal", () => {
    // "The goal was cleared" and "this build cannot read the latest goal event" are
    // different facts, and the second one must never render as the first.
    const goal = foldSessionGoal([goalUpdate(1, "first goal"), event(2, "session.goal_updated")]);
    expect(goal).toStrictEqual({ status: "unreadable", revision: expect.any(String) });
  });

  it("answers none for a log that carries no goal event at all", () => {
    expect(foldSessionGoal([event(1, "run.queued")])).toStrictEqual({
      status: "none",
      revision: expect.any(String),
    });
    expect(foldSessionGoal([])).toStrictEqual({ status: "none", revision: expect.any(String) });
  });

  it("negative control: a non-goal event after an update does not change the answer", () => {
    // Without this, a fold that stopped at the last entry of any kind would pass
    // every case above and still be wrong on the ordinary session.
    const goal = foldSessionGoal([goalUpdate(1, "the goal"), event(2, "assistant.message")]);
    expect(goal).toStrictEqual({ status: "set", text: "the goal", revision: expect.any(String) });
  });
});

// The register's winner is the newest READING, not the newest arrival. A relayed
// event takes its local sequence when it lands here, so a delayed one can sit at a
// higher position than the event it preceded. Every case below is one the fold that
// stopped at the newest local position answered wrong.
const TIED_INSTANT = "2026-01-01T00:00:05.000Z";

describe("the fold ranks readings rather than arrivals", () => {
  it("takes the later instant when it was delivered first", () => {
    // Negative control on the old fold: it returned the earlier instant's text,
    // because that event carries the higher local sequence.
    const goal = foldSessionGoal([
      goalUpdate(1, "authored later", "2026-01-01T00:00:09.000Z"),
      goalUpdate(2, "authored earlier", "2026-01-01T00:00:01.000Z"),
    ]);
    expect(goal).toStrictEqual({
      status: "set",
      text: "authored later",
      revision: expect.any(String),
    });
  });

  it("lets a clear beat an earlier update and an update beat an earlier clear", () => {
    const clearWins = foldSessionGoal([
      goalClear(1, "2026-01-01T00:00:09.000Z"),
      goalUpdate(2, "authored earlier", "2026-01-01T00:00:01.000Z"),
    ]);
    expect(clearWins).toStrictEqual({ status: "none", revision: expect.any(String) });

    const updateWins = foldSessionGoal([
      goalUpdate(1, "authored later", "2026-01-01T00:00:09.000Z"),
      goalClear(2, "2026-01-01T00:00:01.000Z"),
    ]);
    expect(updateWins).toStrictEqual({
      status: "set",
      text: "authored later",
      revision: expect.any(String),
    });
  });

  it("breaks an exact-instant tie on the envelope id, in either arrival order", () => {
    // The envelope's own identifier is the order below the instant, and it is the
    // same on every node — so the two arrival orders answer alike. Local sequence
    // would have answered "arrived second" once and "arrived first" once.
    const earlierId = event(
      7,
      "session.goal_updated",
      { goal: { text: "lower id" } },
      TIED_INSTANT,
    );
    const laterId = event(8, "session.goal_updated", { goal: { text: "higher id" } }, TIED_INSTANT);
    expect(foldSessionGoal([earlierId, laterId])).toStrictEqual({
      status: "set",
      text: "higher id",
      revision: expect.any(String),
    });
    expect(foldSessionGoal([laterId, earlierId])).toStrictEqual({
      status: "set",
      text: "higher id",
      revision: expect.any(String),
    });
  });

  it("reports the winner's unreadable payload rather than the loser's readable one", () => {
    const goal = foldSessionGoal([
      goalUpdate(1, "readable but older", "2026-01-01T00:00:01.000Z"),
      event(2, "session.goal_updated", undefined, "2026-01-01T00:00:09.000Z"),
    ]);
    expect(goal).toStrictEqual({ status: "unreadable", revision: expect.any(String) });
  });

  it("never lets an unreadable stamp beat a readable one, in either arrival order", () => {
    const unreadableArrivesLast = foldSessionGoal([
      goalUpdate(1, "readable stamp", "2026-01-01T00:00:01.000Z"),
      goalUpdate(2, "unreadable stamp", "whenever"),
    ]);
    expect(unreadableArrivesLast).toStrictEqual({
      status: "set",
      text: "readable stamp",
      revision: expect.any(String),
    });

    const unreadableArrivesFirst = foldSessionGoal([
      goalUpdate(1, "unreadable stamp", "whenever"),
      goalUpdate(2, "readable stamp", "2026-01-01T00:00:01.000Z"),
    ]);
    expect(unreadableArrivesFirst).toStrictEqual({
      status: "set",
      text: "readable stamp",
      revision: expect.any(String),
    });
  });
});

// The two-stage fold. Within one origin daemon its own append order decides, and
// only between different origins' winners does the envelope comparator apply. Every
// case here is one the single-stage `(occurredAt, local sequence)` ranking answered
// wrong, and the last one is the property the whole ranking exists to have.
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
