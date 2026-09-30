// The reductions one reading makes on the next, driven with no bridge and no clock.

import type { ArtifactId } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import type { ArtifactManifestRow, ArtifactsSectionState } from "./artifact-model.js";
import { withReplacedRow } from "./artifact-list-reading.js";

function row(id: string, state: ArtifactManifestRow["state"]): ArtifactManifestRow {
  return {
    id: id as ArtifactId,
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

describe("artifact list reading — replacing a row from its own read", () => {
  it("replaces the row the read named and leaves its neighbors alone", () => {
    const listed: ArtifactsSectionState = {
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
    // Without this, a single-artifact read could claim a place no list read established.
    const listed: ArtifactsSectionState = { kind: "listed", rows: [row("first", "published")] };
    const next = withReplacedRow(listed, row("elsewhere", "published"));
    expect(next.kind === "listed" ? next.rows.map((each) => each.id) : []).toStrictEqual(["first"]);
  });

  it("leaves an arm that holds no rows exactly as it found it", () => {
    expect(withReplacedRow({ kind: "loading" }, row("first", "published"))).toStrictEqual({
      kind: "loading",
    });
  });
});
