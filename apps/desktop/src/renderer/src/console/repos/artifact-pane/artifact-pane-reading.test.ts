// The reductions one reading makes on the next, driven with no bridge and no clock.
//
// Each case is about a claim the pane would otherwise make falsely: that a read
// answered for a row it did not name, that a row the list never carried belongs to the
// session, or that a refusal still stands after the act it refused was answered.

import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import type { ArtifactManifestRow, ArtifactsPanelState } from "../artifacts/artifact-model.js";
import {
  NOTHING_READ_YET,
  withReplacedRow,
  withRowRefusal,
  withoutRow,
  withoutRowRefusal,
} from "./artifact-pane-reading.js";

function row(id: string, state: ArtifactManifestRow["state"]): ArtifactManifestRow {
  return {
    id,
    sessionId: "session-1",
    artifactType: "diff",
    digest: "sha256:2b4c",
    size: 4096,
    annotations: {},
    visibility: "shared",
    state,
    metadata: {},
    createdAt: "2026-09-02T07:00:00.000Z",
  };
}

const REFUSAL = refuse("growth-port", "wire-unregistered", "Not checked.");

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
    // Without this, a single-artifact read would be able to claim a session
    // membership that no list read established.
    const listed: ArtifactsPanelState = { kind: "listed", rows: [row("first", "published")] };
    const next = withReplacedRow(listed, row("elsewhere", "published"));
    expect(next.kind === "listed" ? next.rows.map((each) => each.id) : []).toStrictEqual(["first"]);
  });

  it("leaves an arm that holds no rows exactly as it found it", () => {
    expect(withReplacedRow({ kind: "not-checked" }, row("first", "published"))).toStrictEqual({
      kind: "not-checked",
    });
  });
});

describe("artifact pane reading — what a row's last act answered", () => {
  it("records a refusal against the row it was about", () => {
    const recorded = withRowRefusal(NOTHING_READ_YET.refusalByArtifactId, "first", REFUSAL);
    expect(recorded.get("first")).toStrictEqual(REFUSAL);
    expect(NOTHING_READ_YET.refusalByArtifactId.size).toBe(0);
  });

  it("clears the refusal once an act answered for that row", () => {
    const recorded = withRowRefusal(NOTHING_READ_YET.refusalByArtifactId, "first", REFUSAL);
    expect(withoutRowRefusal(recorded, "first").has("first")).toBe(false);
  });

  it("negative control: clearing one row's refusal leaves another's standing", () => {
    const both = withRowRefusal(
      withRowRefusal(NOTHING_READ_YET.refusalByArtifactId, "first", REFUSAL),
      "second",
      REFUSAL,
    );
    const remaining = withoutRowRefusal(both, "first");
    expect(remaining.has("first")).toBe(false);
    expect(remaining.has("second")).toBe(true);
  });
});

describe("artifact pane reading — removing a row a delete answered for", () => {
  it("drops the row the delete named and keeps the rest", () => {
    const listed: ArtifactsPanelState = {
      kind: "listed",
      rows: [row("first", "published"), row("second", "published")],
    };
    const next = withoutRow(listed, "first");
    expect(next.kind === "listed" ? next.rows.map((each) => each.id) : []).toStrictEqual([
      "second",
    ]);
  });

  it("negative control: a delete for a row not on the list removes nothing", () => {
    const listed: ArtifactsPanelState = { kind: "listed", rows: [row("first", "published")] };
    const next = withoutRow(listed, "elsewhere");
    expect(next.kind === "listed" ? next.rows.map((each) => each.id) : []).toStrictEqual(["first"]);
  });

  it("leaves an arm that holds no rows exactly as it found it", () => {
    expect(withoutRow({ kind: "loading" }, "first")).toStrictEqual({ kind: "loading" });
  });
});
