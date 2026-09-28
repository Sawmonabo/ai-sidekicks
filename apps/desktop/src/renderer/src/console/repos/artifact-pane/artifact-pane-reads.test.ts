// What a served list answer reads as.
//
// Driven against the function and not through the reader, because the claim is what an
// answer means and not when it was asked for: the reader's suite owns the scheduling.

import { describe, expect, it } from "vitest";

import { readArtifactList } from "./artifact-pane-reads.js";
import { SERVED_SUMMARY, SESSION_ID } from "./artifact-pane.test-support.js";

describe("artifact pane reads — a served list", () => {
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
        annotations: { "org.opencontainers.image.title": "rate-limit-wiring.patch" },
        subject: undefined,
        state: "published",
        // Freeform provenance is typed `unknown` on the wire and drawn as a string, so
        // a non-string value is rendered in its own form rather than dropped.
        metadata: { mediaType: "text/x-patch", turnOrdinal: "12" },
        createdAt: "2026-09-02T07:00:00.000Z",
      },
    ]);
  });

  it("distinguishes a read that found none from a read still in flight", async () => {
    // Negative control for the case above: a read that answered `loading` for an
    // empty served list would pass every member assertion and still be wrong about the
    // one thing an empty list says.
    const state = await readArtifactList(async () => [], SESSION_ID);
    expect(state).toStrictEqual({ kind: "listed", rows: [] });
  });
});
