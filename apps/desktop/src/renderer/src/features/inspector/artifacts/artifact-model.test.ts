// The artifact vocabularies and the reductions the panel draws from.

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_PRODUCER_ID,
  artifactRow,
  artifactManifest,
} from "@test/helpers/artifact-summaries.js";
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

/** The vocabularies the wire owns, which this feature must not declare a second time. */
const WIRE_OWNED_VOCABULARY_NAMES = ["ARTIFACT_STATES", "ARTIFACT_TYPES"] as const;

describe("artifact-model and artifact-copy — the closed sets", () => {
  it("declares three states and six types", () => {
    // Counted off the presentation table, which the compiler holds total over the wire's set.
    expect(Object.keys(ARTIFACT_STATE_PRESENTATION)).toHaveLength(3);
    expect(ARTIFACT_FILTER_TYPES).toHaveLength(6);
  });

  it("carries `diff` as a type rather than as a separate collection", () => {
    // The diff pane is a view onto this list, never a second store.
    expect(ARTIFACT_FILTER_TYPES).toContain("diff");
  });

  it("negative control: no vocabulary is declared a second time in this feature", () => {
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
    // Total over the six, so the filter can offer a type nothing has produced yet.
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
    // `metadata` is typed `unknown` on the wire, so a `BigInt` or a self-referencing structure
    // can arrive; thrown from the row builder it would take the whole pane down.
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
    // `JSON.stringify` answers `undefined` for these three without throwing, which would put a
    // hole in a `Record<string, string>`.
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
    // Without this everything could go through the total stringifier, and a nested object
    // would render as `[object Object]`.
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
    // `Object.entries` throws on `null` and `undefined`; one row's missing provenance must not
    // take down the list read.
    expect(rowWithMetadata(null).metadata).toStrictEqual({});
    expect(rowWithMetadata(undefined).metadata).toStrictEqual({});
    expect(rowWithMetadata(null).digest).toBe("sha256:3b1f0c");
  });

  it("negative control: a member that IS there is still read", () => {
    // Without this the guard above could be widened to skip every metadata read.
    expect(rowWithMetadata({ producer: "claude-driver" }).metadata).toStrictEqual({
      producer: "claude-driver",
    });
  });

  it("reads `annotations` by the same rule as its sibling map", () => {
    // Nothing parses this map at the port boundary, so an absent map or an object value must
    // be read, not trusted.
    expect(rowWithAnnotations(undefined).annotations).toStrictEqual({});
    expect(rowWithAnnotations(null).annotations).toStrictEqual({});
    expect(rowWithAnnotations({ title: { nested: true } }).annotations).toStrictEqual({
      title: '{"nested":true}',
    });
    expect(rowWithAnnotations({ retries: 3 }).annotations).toStrictEqual({ retries: "3" });
  });

  it("negative control: an annotation that IS a string is still verbatim", () => {
    // Without this every value could be stringified, and a plain annotation would render quoted.
    expect(rowWithAnnotations({ title: "Rebind the repos list" }).annotations).toStrictEqual({
      title: "Rebind the repos list",
    });
  });
});
