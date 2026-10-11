// A message's attachments bound to the stored copies in the order they were staged: a file deleted
// since keeps its place as a marker, and an id in either hex case finds its manifest.

import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";

import { openIngestHarness, type IngestHarness } from "./harness.test-support.js";

let harness: IngestHarness;

afterEach(async () => {
  await harness.close();
});

describe("a message's attachments", () => {
  // Mutations: dropping a missing file shortens the list and shifts every file after it; looking an
  // id up as spelled marks a stored file sent in uppercase as deleted; echoing a marker's id as
  // sent names a file by a spelling no other entry uses.
  it("keep their order around a deleted file, and bind an id in either hex case", async () => {
    harness = await openIngestHarness();
    const encoder = new TextEncoder();
    const plan = await harness.ingest(encoder.encode("the plan"), "plan.md");
    const draft = await harness.ingest(encoder.encode("the draft"), "draft.md");
    const notes = await harness.ingest(encoder.encode("the notes"), "notes.md");
    await harness.database.writer.write([
      {
        sql: "DELETE FROM artifact_payload_refs WHERE manifest_id = ?",
        bindings: [draft.artifactId],
      },
      { sql: "DELETE FROM artifact_manifests WHERE id = ?", bindings: [draft.artifactId] },
    ]);
    const uppercase = (id: ArtifactId): ArtifactId => id.toUpperCase() as ArtifactId;

    const attachments = await harness.attachments.resolveAttachments(harness.sessionId, [
      plan.artifactId,
      uppercase(draft.artifactId),
      uppercase(notes.artifactId),
    ]);

    expect(attachments).toMatchObject([
      { kind: "resolved", artifactId: plan.artifactId, fileName: "plan.md" },
      { kind: "unresolved", artifactId: draft.artifactId, cause: "deleted" },
      { kind: "resolved", artifactId: notes.artifactId, fileName: "notes.md" },
    ]);
  });
});
