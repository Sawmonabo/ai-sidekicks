// The artifact vocabularies and the reductions the panel draws from.
//
// The claims worth asserting here are the ones the design states as rules rather
// than as shapes: that the six types are one filter over one list (so the counts are
// total, zeros included), and that an absent producer is the daemon rather than an
// unknown.

import { describe, expect, it } from "vitest";

import { ARTIFACT_PRODUCER_ID, artifactRow, artifactManifest } from "./artifacts.test-support.js";
import * as artifactModel from "./artifact-model.js";
import {
  ARTIFACT_FILTER_TYPES,
  ARTIFACT_TYPE_FILTER_ALL,
  artifactManifestRowFrom,
  artifactTypeCounts,
  filterArtifactRows,
  type ArtifactManifestRow,
} from "./artifact-model.js";
import {
  ARTIFACT_PRODUCER_ABSENT_LABEL,
  ARTIFACT_STATE_PRESENTATION,
  artifactProducerLabel,
} from "./artifact-copy.js";

/** The vocabularies the wire owns, which this family must not declare a second time. */
const WIRE_OWNED_VOCABULARY_NAMES = ["ARTIFACT_STATES", "ARTIFACT_TYPES"] as const;

describe("artifact-model and artifact-copy — the closed sets", () => {
  it("declares three states and six types", () => {
    // Counted off the presentation table, which is typed `Record<Vocabulary, …>` and so
    // is total over the wire's own set by the compiler rather than by a second array
    // this module would have had to keep in step.
    expect(Object.keys(ARTIFACT_STATE_PRESENTATION)).toHaveLength(3);
    expect(ARTIFACT_FILTER_TYPES).toHaveLength(6);
  });

  it("carries `diff` as a type rather than as a separate collection", () => {
    // Every diff artifact is an artifact and appears in artifact listings, so the
    // diff pane is a view onto this list and never a second store. Membership here
    // is what makes that structural rather than a convention.
    expect(ARTIFACT_FILTER_TYPES).toContain("diff");
  });

  it("negative control: no vocabulary is declared a second time in this family", () => {
    // The module namespace is what a second declaration would show up in.
    for (const vocabulary of WIRE_OWNED_VOCABULARY_NAMES) {
      expect(Object.keys(artifactModel)).not.toContain(vocabulary);
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
    expect(Object.keys(counts)).toHaveLength(ARTIFACT_FILTER_TYPES.length);
  });

  it("negative control: a filter for a type nothing carries returns nothing, not everything", () => {
    expect(filterArtifactRows(rows, "workflow_output")).toStrictEqual([]);
  });
});

describe("artifact-copy — the producer absence is a fact", () => {
  it("names the daemon as the producer when `createdBy` is absent", () => {
    expect(artifactProducerLabel(artifactRow({ createdBy: undefined }))).toBe(
      ARTIFACT_PRODUCER_ABSENT_LABEL,
    );
    expect(ARTIFACT_PRODUCER_ABSENT_LABEL).not.toContain("unknown");
  });

  it("negative control: a present producer is rendered and not replaced", () => {
    expect(artifactProducerLabel(artifactRow({ createdBy: ARTIFACT_PRODUCER_ID }))).toBe(
      ARTIFACT_PRODUCER_ID,
    );
  });
});

describe("artifact manifest row — free-form maps a daemon can send and JSON cannot hold", () => {
  /** One row read from a manifest whose metadata is whatever the case is about. */
  function rowWithMetadata(metadata: unknown): ArtifactManifestRow {
    return artifactManifestRowFrom(artifactManifest({ metadata }));
  }

  /** The same, on the sibling map. */
  function rowWithAnnotations(annotations: unknown): ArtifactManifestRow {
    return artifactManifestRowFrom(artifactManifest({ annotations }));
  }

  it("renders a value JSON refuses to serialize rather than taking the pane down", () => {
    // `metadata` is freeform provenance typed `unknown` on the wire, so a `BigInt` or a
    // structure that refers to itself is a value the daemon can send. Thrown from the row
    // builder it would escape the render, and one provenance entry would take the whole
    // pane with it.
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
    // the whole list read down through `.map`, and the user lost every OTHER
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
    // Its wire type says `Record<string, string>`, and nothing parses it at the port
    // boundary, so an absent map or an object value would take the whole panel down. Three
    // shapes the declared type forbids, each read rather than trusted.
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
