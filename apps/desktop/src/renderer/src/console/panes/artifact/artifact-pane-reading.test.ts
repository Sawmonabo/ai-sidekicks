// The reductions one reading makes on the next, driven with no bridge and no clock.
//
// Each case is about a claim the pane would otherwise make falsely: that a read
// answered for a row it did not name, that a row the list never carried belongs to the
// session, or that a refusal still stands after the act it refused was answered.

import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import type { ArtifactManifestRow, ArtifactsPanelState } from "../../repos/artifact-model.js";
import {
  NOTHING_READ_YET,
  readFailureRefusal,
  withReplacedRow,
  withRowRefusal,
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

describe("artifact pane reading — a read that threw", () => {
  it("carries the failure's own sentence and names this reader as its origin", () => {
    const refusal = readFailureRefusal(new Error("the socket closed"));
    expect(refusal.code).toBe("read-threw");
    expect(refusal.origin).toBe("artifact-pane-reader");
    expect(refusal.detail).toContain("the socket closed");
  });

  it("negative control: a thrown non-error is not rendered as its own text", () => {
    // A thrown value can be anything, including participant content. The sentence
    // says a value was thrown; it never puts the value on screen.
    const refusal = readFailureRefusal({ secret: "do not render me" });
    expect(refusal.detail).not.toContain("do not render me");
    expect(refusal.detail).toContain("not an error");
  });
});
