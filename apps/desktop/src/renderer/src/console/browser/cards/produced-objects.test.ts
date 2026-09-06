// The fold over the log, and the four things it must not do.
//
// The oracle here is the log itself: each case states the beats and the row they are
// supposed to reduce to, and the negative controls are the beats a wrong reader would
// accept — an unreadable state, a missing id, an out-of-order pair, and a second beat
// about an artifact already folded.

import { describe, expect, it } from "vitest";

import { eventOfKind } from "../../store/session-event.test-support.js";
import {
  foldProducedArtifacts,
  producedObjectArtifactId,
  PRODUCED_ARTIFACT_STATES,
  type ProducedObjectCard,
} from "./produced-objects.js";

const SESSION_ID = "session-1";

describe("folding the session's produced objects", () => {
  it("reads one row per artifact, newest first", () => {
    const artifacts = foldProducedArtifacts([
      eventOfKind(SESSION_ID, "artifact.published", 1, {
        artifactId: "artifact-a",
        state: "published",
        runId: "run-1",
      }),
      eventOfKind(SESSION_ID, "artifact.published", 2, {
        artifactId: "artifact-b",
        state: "pending",
      }),
    ]);
    expect(artifacts.map((artifact) => artifact.artifactId)).toEqual(["artifact-b", "artifact-a"]);
    expect(artifacts[1]?.runId).toBe("run-1");
  });

  it("renders every one of the three states the shelf declares", () => {
    const artifacts = foldProducedArtifacts(
      PRODUCED_ARTIFACT_STATES.map((state, index) =>
        eventOfKind(SESSION_ID, "artifact.published", index + 1, {
          artifactId: `artifact-${state}`,
          state,
        }),
      ),
    );
    expect([...artifacts].map((artifact) => artifact.state).sort()).toEqual(
      [...PRODUCED_ARTIFACT_STATES].sort(),
    );
  });

  it("keeps the newest beat about one artifact rather than appending", () => {
    const artifacts = foldProducedArtifacts([
      eventOfKind(SESSION_ID, "artifact.published", 1, {
        artifactId: "artifact-a",
        state: "pending",
      }),
      eventOfKind(SESSION_ID, "artifact.published", 2, {
        artifactId: "artifact-a",
        state: "published",
      }),
      eventOfKind(SESSION_ID, "artifact.superseded", 3, {
        artifactId: "artifact-a",
        state: "superseded",
      }),
    ]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.state).toBe("superseded");
  });

  it("lets the log's position decide, not the order the beats arrived in", () => {
    const artifacts = foldProducedArtifacts([
      eventOfKind(SESSION_ID, "artifact.superseded", 9, {
        artifactId: "artifact-a",
        state: "superseded",
      }),
      eventOfKind(SESSION_ID, "artifact.published", 4, {
        artifactId: "artifact-a",
        state: "published",
      }),
    ]);
    expect(artifacts[0]?.state).toBe("superseded");
  });

  it("carries a visibility change onto the row it is about", () => {
    const artifacts = foldProducedArtifacts([
      eventOfKind(SESSION_ID, "artifact.published", 1, {
        artifactId: "artifact-a",
        state: "published",
      }),
      eventOfKind(SESSION_ID, "artifact.visibility_updated", 2, {
        artifactId: "artifact-a",
        state: "published",
        visibility: "session",
      }),
    ]);
    expect(artifacts[0]?.visibility).toBe("session");
  });

  it("drops a beat it cannot read rather than coercing one", () => {
    const artifacts = foldProducedArtifacts([
      // No id: a row keyed by nothing names no artifact.
      eventOfKind(SESSION_ID, "artifact.published", 1, { state: "published" }),
      // A state outside the three: an unrenderable arm in a total table.
      eventOfKind(SESSION_ID, "artifact.published", 2, {
        artifactId: "artifact-b",
        state: "quarantined",
      }),
      // No payload at all.
      eventOfKind(SESSION_ID, "artifact.published", 3),
    ]);
    expect(artifacts).toEqual([]);
  });

  it("reads no event outside the artifact family", () => {
    const artifacts = foldProducedArtifacts([
      eventOfKind(SESSION_ID, "run.queued", 1, {
        artifactId: "artifact-a",
        state: "published",
      }),
    ]);
    expect(artifacts).toEqual([]);
  });
});

describe("which object a card is about", () => {
  it("reads the identity off either card shape", () => {
    const capture: ProducedObjectCard = {
      kind: "capture",
      props: {
        captureName: "artifact-a",
        scope: "viewport",
        mediaType: "image/png",
        ingest: { status: "stored", artifactId: "artifact-a", byteLength: 4096 },
      },
    };
    const download: ProducedObjectCard = {
      kind: "download",
      props: {
        proposedFileName: "artifact-b",
        sourcePageLabel: "Page 1",
        ingest: { status: "stored", artifactId: "artifact-b", byteLength: 128 },
      },
    };
    expect(producedObjectArtifactId(capture)).toBe("artifact-a");
    expect(producedObjectArtifactId(download)).toBe("artifact-b");
  });
});
