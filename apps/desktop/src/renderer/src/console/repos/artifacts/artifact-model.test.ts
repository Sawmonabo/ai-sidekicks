// The artifact vocabularies and the reductions the panel draws from.
//
// The claims worth asserting here are the ones the design states as rules rather
// than as shapes: that the six types are one filter over one list (so the counts are
// total, zeros included), that an absent producer is the daemon rather than an
// unknown, that an absent replication status is local-only rather than a gap, and
// that `over_cap` / `quota_exceeded` / `expired` say what the design says they say
// rather than what a shorter sentence would.

import { describe, expect, it } from "vitest";

import { REPOS_VIEWING_PARTICIPANT_ID } from "../../bridge/scenarios/repos.js";
import { GROWTH_ARTIFACT_TYPES } from "../../bridge/index.js";
import { artifactRow, artifactSummary } from "./artifacts.test-support.js";
import * as artifactModel from "./artifact-model.js";
import {
  ARTIFACT_TYPE_FILTER_ALL,
  artifactManifestRowFromSummary,
  artifactTypeCounts,
  filterArtifactRows,
  type ArtifactManifestRow,
  type ArtifactReplicationStatus,
} from "./artifact-model.js";
import {
  ARTIFACT_DELETE_CONSEQUENCE,
  ARTIFACT_PAYLOAD_DISPOSITION_COPY,
  ARTIFACT_PRODUCER_ABSENT_LABEL,
  ARTIFACT_REPLICATION_ABSENT,
  ARTIFACT_REPLICATION_PRESENTATION,
  ARTIFACT_STATE_PRESENTATION,
  ARTIFACT_VISIBILITY_PRESENTATION,
  artifactDeleteReceiptSentence,
  artifactProducerLabel,
  artifactReplicationPresentation,
} from "./artifact-copy.js";

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

describe("artifact-model and artifact-copy — the closed sets", () => {
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

describe("artifact-copy — absences that are facts", () => {
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

describe("artifact-copy — the degraded sentences say what the design says", () => {
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

describe("artifact-copy — the delete disclosure states only what is known", () => {
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

describe("artifact manifest row — free-form maps a daemon can send and JSON cannot hold", () => {
  /** One row read from a summary whose metadata is whatever the case is about. */
  function rowWithMetadata(metadata: unknown): ArtifactManifestRow {
    return artifactManifestRowFromSummary(artifactSummary({ metadata }));
  }

  /** The same, on the sibling map — the one that was copied through unread. */
  function rowWithAnnotations(annotations: unknown): ArtifactManifestRow {
    return artifactManifestRowFromSummary(artifactSummary({ annotations }));
  }

  it("renders a value JSON refuses to serialize rather than taking the pane down", () => {
    // `metadata` is freeform provenance typed `unknown` on the wire, so a `BigInt` or
    // a structure that refers to itself is a value the daemon can send. Thrown from
    // the row builder it escapes the fold and the render, and one provenance entry
    // takes the whole pane with it. On the bare `JSON.stringify` this replaces, the
    // construction below throws before a single assertion runs.
    const selfReferential: Record<string, unknown> = { name: "cycle" };
    selfReferential["itself"] = selfReferential;
    const hostile = {
      toJSON(): never {
        throw new Error("this value refuses to be serialized");
      },
    };

    const row = rowWithMetadata({
      byteCount: 9007199254740993n,
      selfReferential,
      hostile,
    });

    expect(typeof row.metadata["byteCount"]).toBe("string");
    expect(row.metadata["byteCount"]).toContain("9007199254740993");
    expect(typeof row.metadata["selfReferential"]).toBe("string");
    expect(typeof row.metadata["hostile"]).toBe("string");
  });

  it("renders a value JSON serializes to nothing rather than writing a hole", () => {
    // The other half, and the quieter one. `JSON.stringify` ANSWERS `undefined` for
    // these three — no throw — so the value went into a `Record<string, string>`
    // unchecked and the row carried a hole the compiler had been told was a string.
    const row = rowWithMetadata({
      absent: undefined,
      callable: () => "provenance",
      named: Symbol("provenance"),
    });

    for (const key of ["absent", "callable", "named"]) {
      expect(typeof row.metadata[key]).toBe("string");
      expect(row.metadata[key]).not.toBe("");
    }
  });

  it("negative control: an ordinary value is still its own JSON, and a string is verbatim", () => {
    // Without this the fix could route everything through the total stringifier, and
    // a nested object would render as `[object Object]` — provenance the row exists to
    // show, replaced by a sentence about JavaScript.
    const row = rowWithMetadata({
      producer: "codex-driver",
      counts: { added: 4, removed: 1 },
      flags: [true, null],
    });

    expect(row.metadata["producer"]).toBe("codex-driver");
    expect(row.metadata["counts"]).toBe('{"added":4,"removed":1}');
    expect(row.metadata["flags"]).toBe("[true,null]");
  });

  it("draws a row with no provenance when the member itself is not there", () => {
    // `Object.entries` THROWS on `null` and on `undefined`, and the member is typed
    // present rather than proven present — so a summary that arrived without it took
    // the whole list read down through `.map`, and the participant lost every OTHER
    // row to one row's missing provenance. A row with nothing to show shows nothing.
    expect(rowWithMetadata(null).metadata).toStrictEqual({});
    expect(rowWithMetadata(undefined).metadata).toStrictEqual({});
    // The row itself is still a row: the members that DID arrive are read.
    expect(rowWithMetadata(null).digest).toBe("sha256:3b1f0c");
  });

  it("negative control: a member that IS there is still read", () => {
    // Without this the guard above could be widened to skip every metadata read, and
    // the rows a deployment does send provenance for would draw none of it.
    expect(rowWithMetadata({ producer: "claude-driver" }).metadata).toStrictEqual({
      producer: "claude-driver",
    });
  });

  it("reads `annotations` by the same rule as its sibling map", () => {
    // The defect: `annotations` was COPIED through while `metadata` five lines down was
    // read. Its wire type says `Record<string, string>`, and nothing parses it at the
    // port boundary — so an absent map threw inside the row's `Object.entries` and an
    // object value reached React as a child object, one row taking the whole panel
    // down. Three shapes the declared type forbids, each read rather than trusted.
    expect(rowWithAnnotations(undefined).annotations).toStrictEqual({});
    expect(rowWithAnnotations(null).annotations).toStrictEqual({});
    expect(rowWithAnnotations({ title: { nested: true } }).annotations).toStrictEqual({
      title: '{"nested":true}',
    });
    expect(rowWithAnnotations({ retries: 3 }).annotations).toStrictEqual({ retries: "3" });
  });

  it("negative control: an annotation that IS a string is still verbatim", () => {
    // Without this the reader could stringify every value, and an ordinary annotation
    // would render quoted — the wire's own text replaced by its JSON form.
    expect(rowWithAnnotations({ title: "Rebind the repos family" }).annotations).toStrictEqual({
      title: "Rebind the repos family",
    });
  });
});
