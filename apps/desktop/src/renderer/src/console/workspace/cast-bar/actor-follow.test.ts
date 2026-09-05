// What a chip press resolves to, checked without rendering a workspace.
//
// The defect this covers is a press that quietly did nothing: in a deck holding one
// timeline the pane it focused was already focused, so following an actor moved
// nothing and said nothing. The resolution below is the half that decides whether
// there is a row to move to at all.

import { describe, expect, it } from "vitest";

import type { ConsoleSessionEvent } from "../../store/index.js";
import { ACTOR_FOLLOW_ANNOUNCEMENTS, resolveActorFollow } from "./actor-follow.js";

function logOf(rows: readonly (readonly [number, string])[]): readonly ConsoleSessionEvent[] {
  return rows.map(([sequence, actorId]) => ({
    id: `event-${String(sequence)}`,
    sessionId: "session-1",
    sequence,
    kind: "user.message",
    occurredAt: "2026-01-01T14:20:00.000Z",
    actorId,
  }));
}

describe("resolveActorFollow", () => {
  it("finds the participant's NEWEST row, not their first", () => {
    const resolution = resolveActorFollow(
      logOf([
        [1, "agent-scout"],
        [2, "participant-you"],
        [3, "agent-scout"],
        [4, "participant-you"],
      ]),
      "agent-scout",
    );
    expect(resolution).toStrictEqual({ outcome: "follow", newestSequence: 3 });
  });

  it("says a participant with no row has nothing to follow", () => {
    const resolution = resolveActorFollow(logOf([[1, "participant-you"]]), "agent-scout");
    expect(resolution).toStrictEqual({ outcome: "no-activity" });
  });

  it("says the same of an empty log", () => {
    expect(resolveActorFollow([], "agent-scout")).toStrictEqual({ outcome: "no-activity" });
  });

  // The negative control: an unattributed row is not a match for anybody. Without it
  // the cases above would pass over a resolution that returned the log's tail
  // whoever was asked for.
  it("negative control: an unattributed row follows nobody", () => {
    const unattributed: readonly ConsoleSessionEvent[] = [
      {
        id: "event-9",
        sessionId: "session-1",
        sequence: 9,
        kind: "session.created",
        occurredAt: "2026-01-01T14:20:00.000Z",
      },
    ];
    expect(resolveActorFollow(unattributed, "agent-scout")).toStrictEqual({
      outcome: "no-activity",
    });
  });

  it("keeps one sentence per way a follow can fail", () => {
    // A closed set with one home: three failures, three sentences, and none of them
    // written at a call site where a fourth could appear unnoticed.
    expect(Object.keys(ACTOR_FOLLOW_ANNOUNCEMENTS)).toStrictEqual([
      "no-activity",
      "row-not-in-view",
      "no-ledger",
    ]);
  });
});
