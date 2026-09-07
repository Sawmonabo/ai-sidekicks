// The fold over the log, and the five things it must not do.
//
// The oracle here is the log itself: each case states the beats and the row they are
// supposed to reduce to, and the negative controls are the beats a wrong reader would
// accept — an unreadable state, a missing id, an out-of-order pair, a second beat
// about an artifact already folded, and an artifact this window never produced.

import { describe, expect, it } from "vitest";

import { eventOfKind } from "../../store/session-event.test-support.js";
import { PRODUCED_ARTIFACT_STATES } from "./produced-artifact-state.js";
import {
  foldProducedArtifacts,
  producedObjectArtifactId,
  type ProducedObjectCard,
} from "./produced-objects.js";

const SESSION_ID = "session-1";

/** The provenance a case supplies: the ids this window's own acts answered with. */
function produced(...artifactIds: readonly string[]): ReadonlySet<string> {
  return new Set(artifactIds);
}

describe("folding the session's produced objects", () => {
  it("reads one row per artifact, newest first", () => {
    const artifacts = foldProducedArtifacts(
      [
        eventOfKind(SESSION_ID, "artifact.published", 1, {
          artifactId: "artifact-a",
          state: "published",
          runId: "run-1",
        }),
        eventOfKind(SESSION_ID, "artifact.published", 2, {
          artifactId: "artifact-b",
          state: "pending",
        }),
      ],
      produced("artifact-a", "artifact-b"),
    );
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
      produced(...PRODUCED_ARTIFACT_STATES.map((state) => `artifact-${state}`)),
    );
    expect([...artifacts].map((artifact) => artifact.state).sort()).toEqual(
      [...PRODUCED_ARTIFACT_STATES].sort(),
    );
  });

  it("keeps the newest beat about one artifact rather than appending", () => {
    const artifacts = foldProducedArtifacts(
      [
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
      ],
      produced("artifact-a"),
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.state).toBe("superseded");
  });

  it("lets the log's position decide, not the order the beats arrived in", () => {
    const artifacts = foldProducedArtifacts(
      [
        eventOfKind(SESSION_ID, "artifact.superseded", 9, {
          artifactId: "artifact-a",
          state: "superseded",
        }),
        eventOfKind(SESSION_ID, "artifact.published", 4, {
          artifactId: "artifact-a",
          state: "published",
        }),
      ],
      produced("artifact-a"),
    );
    expect(artifacts[0]?.state).toBe("superseded");
  });

  it("carries a visibility change onto the row it is about", () => {
    const artifacts = foldProducedArtifacts(
      [
        eventOfKind(SESSION_ID, "artifact.published", 1, {
          artifactId: "artifact-a",
          state: "published",
        }),
        eventOfKind(SESSION_ID, "artifact.visibility_updated", 2, {
          artifactId: "artifact-a",
          state: "published",
          visibility: "session",
        }),
      ],
      produced("artifact-a"),
    );
    expect(artifacts[0]?.visibility).toBe("session");
  });

  it("drops a beat it cannot read rather than coercing one", () => {
    const artifacts = foldProducedArtifacts(
      [
        // No id: a row keyed by nothing names no artifact.
        eventOfKind(SESSION_ID, "artifact.published", 1, { state: "published" }),
        // A state outside the three: an unrenderable arm in a total table.
        eventOfKind(SESSION_ID, "artifact.published", 2, {
          artifactId: "artifact-b",
          state: "quarantined",
        }),
        // No payload at all.
        eventOfKind(SESSION_ID, "artifact.published", 3),
      ],
      produced("artifact-b"),
    );
    expect(artifacts).toEqual([]);
  });

  it("reads no event outside the artifact family", () => {
    const artifacts = foldProducedArtifacts(
      [
        eventOfKind(SESSION_ID, "run.queued", 1, {
          artifactId: "artifact-a",
          state: "published",
        }),
      ],
      produced("artifact-a"),
    );
    expect(artifacts).toEqual([]);
  });
});

// Provenance: which of a session's artifacts this shelf may claim.
//
// The `artifact_publication` payload names no producer — a repository attachment
// published from the same session is byte-for-byte the shape a browser capture takes —
// so a fold that accepted every readable artifact beat listed one surface's output
// under another's heading. The only record that an object came out of the browser is
// the pane's own operation reply, and that is what these cases supply.
describe("which artifacts the browser may claim as its own", () => {
  const MIXED_SESSION = [
    // A repository attachment: `Spec-014`'s relay member and a shared visibility, and
    // otherwise indistinguishable from the capture below.
    eventOfKind(SESSION_ID, "artifact.published", 1, {
      artifactId: "artifact-repo-attachment",
      state: "published",
      runId: "run-implementer",
      visibility: "shared",
      replicationStatus: "pinned",
    }),
    eventOfKind(SESSION_ID, "artifact.published", 2, {
      artifactId: "artifact-browser-capture",
      state: "published",
      runId: "run-implementer",
      visibility: "local-only",
    }),
  ];

  it("lists the capture this window took and not the attachment beside it", () => {
    const artifacts = foldProducedArtifacts(MIXED_SESSION, produced("artifact-browser-capture"));
    expect(artifacts.map((artifact) => artifact.artifactId)).toEqual(["artifact-browser-capture"]);
  });

  it("keeps the run a later beat did not repeat, and takes the newer state", () => {
    // `runId` is OPTIONAL on the payload, and a `visibility_updated` beat names the
    // new visibility and routinely carries no run. A fold that replaced the row read
    // that omission as "this artifact now has no run" and deleted the attribution the
    // publish had established — a claim about the artifact nothing on the wire made.
    const artifacts = foldProducedArtifacts(
      [
        eventOfKind(SESSION_ID, "artifact.published", 1, {
          artifactId: "artifact-a",
          state: "published",
          runId: "run-1",
          visibility: "local-only",
        }),
        eventOfKind(SESSION_ID, "artifact.visibility_updated", 2, {
          artifactId: "artifact-a",
          state: "published",
          visibility: "shared",
        }),
      ],
      produced("artifact-a"),
    );
    expect(artifacts[0]?.runId).toBe("run-1");
    expect(artifacts[0]?.visibility).toBe("shared");
    expect(artifacts[0]?.latestSequence).toBe(2);
  });

  it("keeps the visibility a supersession did not repeat", () => {
    // The same rule on the other member: a supersession names neither, so both the
    // run and the visibility survive it while the STATE moves.
    const artifacts = foldProducedArtifacts(
      [
        eventOfKind(SESSION_ID, "artifact.published", 1, {
          artifactId: "artifact-a",
          state: "published",
          runId: "run-1",
          visibility: "shared",
        }),
        eventOfKind(SESSION_ID, "artifact.superseded", 2, {
          artifactId: "artifact-a",
          state: "superseded",
        }),
      ],
      produced("artifact-a"),
    );
    expect(artifacts[0]?.state).toBe("superseded");
    expect(artifacts[0]?.visibility).toBe("shared");
    expect(artifacts[0]?.runId).toBe("run-1");
  });

  it("fills an absent member from an out-of-order beat without taking its state", () => {
    // The same rule read the other way. The publish arrives AFTER the supersession
    // this loop already folded, so it must not decide the state — and it is still the
    // only beat that ever named the run, so dropping it whole loses the attribution.
    const artifacts = foldProducedArtifacts(
      [
        eventOfKind(SESSION_ID, "artifact.superseded", 2, {
          artifactId: "artifact-a",
          state: "superseded",
        }),
        eventOfKind(SESSION_ID, "artifact.published", 1, {
          artifactId: "artifact-a",
          state: "published",
          runId: "run-1",
          visibility: "local-only",
        }),
      ],
      produced("artifact-a"),
    );
    expect(artifacts[0]?.state).toBe("superseded");
    expect(artifacts[0]?.latestSequence).toBe(2);
    expect(artifacts[0]?.runId).toBe("run-1");
    expect(artifacts[0]?.visibility).toBe("local-only");
  });

  it("negative control: a later beat that NAMES a member replaces it rather than merging", () => {
    // Without this the merge above would be indistinguishable from a fold that never
    // lets an optional member change at all — so a visibility the session actually
    // moved would stay on screen as whatever it was first published as.
    const artifacts = foldProducedArtifacts(
      [
        eventOfKind(SESSION_ID, "artifact.published", 1, {
          artifactId: "artifact-a",
          state: "published",
          runId: "run-1",
          visibility: "local-only",
        }),
        eventOfKind(SESSION_ID, "artifact.visibility_updated", 2, {
          artifactId: "artifact-a",
          state: "published",
          runId: "run-2",
          visibility: "shared",
        }),
      ],
      produced("artifact-a"),
    );
    expect(artifacts[0]?.runId).toBe("run-2");
    expect(artifacts[0]?.visibility).toBe("shared");
  });

  it("negative control: a window that produced nothing claims nothing", () => {
    // Without the join, this same log folds to two rows on a shelf headed "Produced
    // objects" in a window whose browser has produced none of them.
    expect(foldProducedArtifacts(MIXED_SESSION, produced())).toEqual([]);
  });
});

describe("which object a card is about", () => {
  it("reads the identity off either card shape, through the one member", () => {
    // No `captureName`: the capture reply carries none, and the id is never promoted
    // into the name slot to stand in for one.
    const capture: ProducedObjectCard = {
      kind: "capture",
      props: {
        artifactId: "artifact-a",
        scope: "viewport",
        mediaType: "image/png",
        ingest: { status: "stored", artifactId: "artifact-a", byteLength: 4096 },
      },
    };
    // The proposed name is deliberately NOT the artifact id here. A download card
    // keyed on what the page suggested would never be found by the shelf, which looks
    // cards up by the id the log's fold carries — the defect this member closes.
    const download: ProducedObjectCard = {
      kind: "download",
      props: {
        artifactId: "artifact-b",
        proposedFileName: "quarterly-report.pdf",
        sourcePageLabel: "Page 1",
        ingest: { status: "stored", artifactId: "artifact-b", byteLength: 128 },
      },
    };
    expect(producedObjectArtifactId(capture)).toBe("artifact-a");
    expect(producedObjectArtifactId(download)).toBe("artifact-b");
  });
});
