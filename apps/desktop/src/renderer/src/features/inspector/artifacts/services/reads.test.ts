// What a served list answer reads as, driven against the function rather than the reader,
// whose suite owns the scheduling.

import { describe, expect, it } from "vitest";

import { readArtifactList } from "./reads.js";
import { SERVED_SUMMARY, SESSION_ID } from "#test/helpers/artifact-list-readers.js";

describe("artifact list reads — a served list", () => {
  it("reads a served manifest summary as a row, member for member", async () => {
    const state = await readArtifactList(async () => [SERVED_SUMMARY], SESSION_ID);
    expect(state.kind).toBe("listed");
    expect(state.kind === "listed" ? state.rows : []).toStrictEqual([
      {
        id: "019b7b30-0280-7c11-8420-b1a5c0de2201",
        sessionId: SESSION_ID,
        runId: "019b7b30-0280-7c11-8420-b1a5c0de2202",
        createdBy: "019b7b30-0280-7c11-8420-b1a5c0de2203",
        artifactType: "diff",
        digest: "sha256:2b4c",
        size: 4096,
        state: "published",
        // Freeform provenance is `unknown` on the wire and drawn as a string.
        metadata: { mediaType: "text/x-patch", turnOrdinal: "12" },
        createdAt: "2026-09-02T07:00:00.000Z",
      },
    ]);
  });

  it("distinguishes a read that found none from a read still in flight", async () => {
    // A read answering `loading` for an empty served list would pass every member assertion.
    const state = await readArtifactList(async () => [], SESSION_ID);
    expect(state).toStrictEqual({ kind: "listed", rows: [] });
  });
});
