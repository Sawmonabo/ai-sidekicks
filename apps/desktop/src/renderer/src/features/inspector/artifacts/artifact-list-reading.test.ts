// The reductions one reading makes on the next, driven with no bridge and no clock.
//
// Each case is about a claim the pane would otherwise make falsely: that a read answered
// for a row it did not name, or that a row the list never carried belongs to the session.

import { describe, expect, it } from "vitest";

import type { ArtifactManifestRow, ArtifactsPanelState } from "./artifact-model.js";
import { withReplacedRow } from "./artifact-list-reading.js";

function row(id: string, state: ArtifactManifestRow["state"]): ArtifactManifestRow {
  return {
    id,
    sessionId: "session-1",
    artifactType: "diff",
    digest: "sha256:2b4c",
    size: 4096,
    annotations: {},
    state,
    metadata: {},
    createdAt: "2026-09-02T07:00:00.000Z",
  };
}

describe("artifact pane reading — replacing a row from its own read", () => {
  it("replaces the row the read named and leaves its neighbours alone", () => {
    const listed: ArtifactsPanelState = {
      kind: "listed",
      rows: [row("first", "published"), row("second", "published")],
    };
    const next = withReplacedRow(listed, row("second", "superseded"));
    expect(next.kind === "listed" ? next.rows.map((each) => each.state) : []).toStrictEqual([
      "published",
      "superseded",
    ]);
  });

  it("negative control: a row the list does not carry is not added to it", () => {
    // Without this, a single-artifact read would be able to claim a place in the
    // list that no list read established.
    const listed: ArtifactsPanelState = { kind: "listed", rows: [row("first", "published")] };
    const next = withReplacedRow(listed, row("elsewhere", "published"));
    expect(next.kind === "listed" ? next.rows.map((each) => each.id) : []).toStrictEqual(["first"]);
  });

  it("leaves an arm that holds no rows exactly as it found it", () => {
    expect(withReplacedRow({ kind: "loading" }, row("first", "published"))).toStrictEqual({
      kind: "loading",
    });
  });
});
