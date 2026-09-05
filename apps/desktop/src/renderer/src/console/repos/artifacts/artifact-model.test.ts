// The artifact vocabularies and the reductions the panel draws from.
//
// The claims worth asserting here are the ones the design states as rules rather
// than as shapes: that the six types are one filter over one list (so the counts are
// total, zeros included), that an absent producer is the daemon rather than an
// unknown, that an absent replication status is local-only rather than a gap, and
// that `over_cap` / `quota_exceeded` / `expired` say what the design says they say
// rather than what a shorter sentence would.

import { describe, expect, it } from "vitest";

import { GROWTH_ARTIFACT_TYPES } from "../../bridge/index.js";
import {
  REPOS_IMPLEMENTER_RUN_ID,
  REPOS_SESSION_ID,
  REPOS_VIEWING_PARTICIPANT_ID,
} from "../../bridge/scenarios/repos.js";
import * as artifactModel from "./artifact-model.js";
import {
  ARTIFACT_DELETE_CONSEQUENCE,
  ARTIFACT_PAYLOAD_DISPOSITION_COPY,
  ARTIFACT_PRODUCER_ABSENT_LABEL,
  ARTIFACT_REPLICATION_ABSENT,
  ARTIFACT_REPLICATION_PRESENTATION,
  ARTIFACT_STATE_PRESENTATION,
  ARTIFACT_TYPE_FILTER_ALL,
  ARTIFACT_VISIBILITY_PRESENTATION,
  artifactDeleteReceiptSentence,
  artifactProducerLabel,
  artifactReplicationPresentation,
  artifactTypeCounts,
  filterArtifactRows,
  type ArtifactManifestRow,
  type ArtifactReplicationStatus,
} from "./artifact-model.js";

/**
 * The five vocabularies this module used to declare a second copy of.
 *
 * Named here so the control below reads as one claim rather than five, and so a
 * sixth copy re-introduced under a new name is a one-line addition to this list.
 */
const WIRE_OWNED_VOCABULARY_NAMES = [
  "ARTIFACT_STATES",
  "ARTIFACT_VISIBILITIES",
  "ARTIFACT_TYPES",
  "ARTIFACT_REPLICATION_STATUSES",
  "ARTIFACT_PAYLOAD_DISPOSITIONS",
] as const;

function artifactRow(overrides: Partial<ArtifactManifestRow> = {}): ArtifactManifestRow {
  return {
    id: "artifact-01",
    sessionId: REPOS_SESSION_ID,
    runId: REPOS_IMPLEMENTER_RUN_ID,
    createdBy: REPOS_VIEWING_PARTICIPANT_ID,
    artifactType: "file",
    digest: "sha256:3b1f0c",
    size: 4096,
    annotations: {},
    visibility: "local-only",
    state: "published",
    metadata: {},
    createdAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("artifact-model — the closed sets", () => {
  it("declares three states, two visibility classes, six types, and five replication statuses", () => {
    // Counted off the presentation tables, which are typed `Record<Vocabulary, …>`
    // and so are total over the wire's own set by the compiler rather than by a
    // second array this module would have had to keep in step.
    expect(Object.keys(ARTIFACT_STATE_PRESENTATION)).toHaveLength(3);
    expect(Object.keys(ARTIFACT_VISIBILITY_PRESENTATION)).toHaveLength(2);
    expect(GROWTH_ARTIFACT_TYPES).toHaveLength(6);
    expect(Object.keys(ARTIFACT_REPLICATION_PRESENTATION)).toHaveLength(5);
    expect(Object.keys(ARTIFACT_PAYLOAD_DISPOSITION_COPY)).toHaveLength(3);
  });

  it("carries `diff` as a type rather than as a separate collection", () => {
    // Every diff artifact is an artifact and appears in artifact listings, so the
    // diff pane is a view onto this list and never a second store. Membership here
    // is what makes that structural rather than a convention.
    expect(GROWTH_ARTIFACT_TYPES).toContain("diff");
  });

  it("negative control: no vocabulary is declared a second time in this family", () => {
    // The whole finding: five sets existed here AND on `growth-values/artifacts.ts`,
    // member for member, each under a comment claiming to be the one home. The
    // module namespace is what a second declaration would show up in, and it fails
    // on the code this replaced, where all five were exported from here.
    for (const vocabulary of WIRE_OWNED_VOCABULARY_NAMES) {
      expect(Object.keys(artifactModel)).not.toContain(vocabulary);
    }
  });

  it("draws a presentation for every replication status the wire declares", () => {
    // Totality against the WIRE's census rather than against a local list: the
    // direction that used to be silent is the wire dropping a member, which a local
    // list goes on enumerating with nothing failing.
    for (const status of Object.keys(ARTIFACT_REPLICATION_PRESENTATION)) {
      const declared: ArtifactReplicationStatus = status as ArtifactReplicationStatus;
      expect(ARTIFACT_REPLICATION_PRESENTATION[declared].meaning.length).toBeGreaterThan(0);
    }
  });
});

describe("artifact-model — the type filter", () => {
  const rows = [
    artifactRow({ id: "a", artifactType: "file" }),
    artifactRow({ id: "b", artifactType: "diff" }),
    artifactRow({ id: "c", artifactType: "diff" }),
  ];

  it("admits every row under `all` and narrows to one type otherwise", () => {
    expect(filterArtifactRows(rows, ARTIFACT_TYPE_FILTER_ALL)).toHaveLength(3);
    expect(filterArtifactRows(rows, "diff").map((row) => row.id)).toStrictEqual(["b", "c"]);
  });

  it("keeps arrival order rather than sorting", () => {
    expect(filterArtifactRows(rows, ARTIFACT_TYPE_FILTER_ALL).map((row) => row.id)).toStrictEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("counts every type, zeros included", () => {
    const counts = artifactTypeCounts(rows);
    expect(counts).toStrictEqual({
      file: 1,
      diff: 2,
      summary: 0,
      log: 0,
      design: 0,
      workflow_output: 0,
    });
    // Total over the six, so the filter can offer a type nothing has produced yet —
    // hiding it would hide the vocabulary exactly when somebody is looking for
    // something that is not there.
    expect(Object.keys(counts)).toHaveLength(GROWTH_ARTIFACT_TYPES.length);
  });

  it("negative control: a filter for a type nothing carries returns nothing, not everything", () => {
    expect(filterArtifactRows(rows, "workflow_output")).toStrictEqual([]);
  });
});

describe("artifact-model — absences that are facts", () => {
  it("names the daemon as the producer when `createdBy` is absent", () => {
    expect(artifactProducerLabel(artifactRow({ createdBy: undefined }))).toBe(
      ARTIFACT_PRODUCER_ABSENT_LABEL,
    );
    expect(ARTIFACT_PRODUCER_ABSENT_LABEL).not.toContain("unknown");
  });

  it("negative control: a present producer is rendered and not replaced", () => {
    expect(artifactProducerLabel(artifactRow({ createdBy: REPOS_VIEWING_PARTICIPANT_ID }))).toBe(
      REPOS_VIEWING_PARTICIPANT_ID,
    );
  });

  it("reads an absent replication status as local-only rather than as a gap", () => {
    expect(artifactReplicationPresentation(artifactRow({ replicationStatus: undefined }))).toBe(
      ARTIFACT_REPLICATION_ABSENT,
    );
    expect(ARTIFACT_REPLICATION_ABSENT.meaning).toContain("Local-only");
  });

  it("reads a present status verbatim and never recomputes it", () => {
    // The persisted value is what lets an unresolved attachment marker carry a
    // non-`pinned` status as its cause, so the mapping is total and one-way.
    for (const status of Object.keys(ARTIFACT_REPLICATION_PRESENTATION)) {
      const declared: ArtifactReplicationStatus = status as ArtifactReplicationStatus;
      expect(artifactReplicationPresentation(artifactRow({ replicationStatus: declared }))).toBe(
        ARTIFACT_REPLICATION_PRESENTATION[declared],
      );
    }
  });
});

describe("artifact-model — the degraded sentences say what the design says", () => {
  it("blames the publisher being offline, not a cap the participant cannot see", () => {
    expect(ARTIFACT_REPLICATION_PRESENTATION.over_cap.meaning).toBe(
      "Unavailable while the publisher is offline.",
    );
    expect(ARTIFACT_REPLICATION_PRESENTATION.quota_exceeded.meaning).toBe(
      "Unavailable while the publisher is offline.",
    );
  });

  it("states `expired` as an unobtainable payload with a remedy, never as an elapsed clock", () => {
    const expired = ARTIFACT_REPLICATION_PRESENTATION.expired.meaning;
    expect(expired).toContain("not obtainable from the relay");
    expect(expired).toContain("re-publishing");
    // Negative control on the copy itself: the narrow reading describes the cause
    // and hides the way out, which is why the design forbids it.
    expect(expired).not.toContain("TTL");
  });

  it("reports where the bytes went in all three dispositions", () => {
    const sentences = Object.values(ARTIFACT_PAYLOAD_DISPOSITION_COPY);
    expect(new Set(sentences).size).toBe(sentences.length);
    expect(ARTIFACT_PAYLOAD_DISPOSITION_COPY.retained_by_references).toContain("another manifest");
  });
});

describe("artifact-model — the delete disclosure states only what is known when it is stated", () => {
  it("makes the pre-action consequence conditional on a fact the receipt settles", () => {
    // `rePublishForeclosed` is a property of the row the daemon observes as it goes,
    // so before the act the console knows only that deletion MAY cost the re-publish.
    expect(ARTIFACT_DELETE_CONSEQUENCE).toContain("may foreclose re-publishing");
    expect(ARTIFACT_DELETE_CONSEQUENCE).toContain("retained relay key");
    expect(ARTIFACT_DELETE_CONSEQUENCE).toContain("receipt");
    // Negative control: the unconditional claim this copy replaced. It was false for
    // every artifact whose receipt comes back `rePublishForeclosed: false`, and the
    // panel then printed the contradiction two lines further down.
    expect(ARTIFACT_DELETE_CONSEQUENCE).not.toContain("Deleting forecloses");
  });

  it("reports re-publishing as still possible where the receipt says no key died", () => {
    const sentence = artifactDeleteReceiptSentence({
      artifactId: "artifact-01",
      rePublishForeclosed: false,
      payloadDisposition: "retained_by_references",
    });
    expect(sentence).toContain("Re-publishing is still possible.");
    expect(sentence).not.toContain("permanently impossible");
  });

  it("reports the foreclosure as a fact where the receipt says the key died", () => {
    const sentence = artifactDeleteReceiptSentence({
      artifactId: "artifact-01",
      rePublishForeclosed: true,
      payloadDisposition: "reclaimed",
    });
    expect(sentence).toContain("permanently impossible");
    // Negative control on the pair: the two receipts must not read the same, which is
    // the whole reason the flag rides the reply.
    expect(sentence).not.toContain("still possible");
  });
});
