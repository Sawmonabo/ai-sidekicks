// The subagent anchor: a later row naming an identity already anchored moves nothing, where a
// last-wins fold would move the card.

import { describe, expect, it } from "vitest";

import { generalRow, runRow } from "../event-rows.test-support.js";
import {
  SubagentAnchorIndex,
  deriveSubagentAnchors,
  subagentIdentityKey,
  subagentIdentityOf,
} from "./subagent-anchors.js";

const SUBAGENT = { provider: "claude", subagentId: "sub-1" };

function subagentRow(
  id: string,
  sequence: number,
  type: string,
  runId = "run-a",
): ReturnType<typeof runRow> {
  return runRow({ id, sequence, type, runId, position: sequence, payload: { ...SUBAGENT } });
}

describe("the identity — read from three members, never inferred", () => {
  it("keys on the run, the provider and the subagent together", () => {
    const identity = subagentIdentityOf(subagentRow("r1", 1, "subagent.started"));
    expect(identity).toEqual({ runId: "run-a", provider: "claude", subagentId: "sub-1" });
    expect(subagentIdentityKey(identity!)).toBe("run-a claude sub-1");
  });

  it("refuses a row that names a subagent under no provider", () => {
    expect(
      subagentIdentityOf(
        runRow({
          id: "r1",
          sequence: 1,
          type: "subagent.started",
          runId: "run-a",
          position: 1,
          payload: { subagentId: "sub-1" },
        }),
      ),
    ).toBeUndefined();
  });

  it("refuses a row that carries no run attribution at all", () => {
    expect(
      subagentIdentityOf(
        generalRow({ id: "g1", sequence: 1, type: "subagent.started", payload: { ...SUBAGENT } }),
      ),
    ).toBeUndefined();
  });
});

describe("the anchor — first-wins, and every later row of the identity joins it", () => {
  it("does not re-anchor on a completion", () => {
    const anchors = deriveSubagentAnchors([
      subagentRow("start", 1, "subagent.started"),
      subagentRow("done", 2, "subagent.completed"),
      subagentRow("done-again", 3, "subagent.completed"),
    ]);
    const anchor = anchors.get("run-a claude sub-1");
    expect(anchor?.anchorRowId).toBe("start");
    expect(anchor?.rowIds).toEqual(["start", "done", "done-again"]);
  });

  it("keeps two subagents of one provider apart", () => {
    const anchors = deriveSubagentAnchors([
      subagentRow("first", 1, "subagent.started"),
      runRow({
        id: "second",
        sequence: 2,
        type: "subagent.started",
        runId: "run-a",
        position: 2,
        payload: { provider: "claude", subagentId: "sub-2" },
      }),
    ]);
    expect([...anchors.keys()]).toEqual(["run-a claude sub-1", "run-a claude sub-2"]);
  });

  it("answers the per-row question the feed asks", () => {
    const index = new SubagentAnchorIndex([
      subagentRow("start", 1, "subagent.started"),
      subagentRow("done", 2, "subagent.completed"),
      runRow({ id: "plain", sequence: 3, type: "user.message", runId: "run-a", position: 3 }),
    ]);
    expect(index.isAnchorRow("start")).toBe(true);
    expect(index.isAnchoredElsewhere("start")).toBe(false);
    expect(index.isAnchoredElsewhere("done")).toBe(true);
    expect(index.isAnchoredElsewhere("plain")).toBe(false);
  });
});
