// What a manifest row reads a daemon's free-form metadata as: no value takes the pane down.

import { describe, expect, it } from "vitest";

import { artifactManifest } from "./artifact-model.test-support.js";
import { artifactManifestRowFrom, type ArtifactManifestRow } from "./artifact-model.js";

describe("artifact manifest row: metadata a daemon can send and JSON cannot hold", () => {
  /** One row read from a manifest whose metadata is whatever the case is about. */
  function rowWithMetadata(metadata: unknown): ArtifactManifestRow {
    return artifactManifestRowFrom(artifactManifest({ metadata }));
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
    expect(rowWithMetadata(null).digest).toBe("sha256:2b4c");
  });

  it("negative control: a member that IS there is still read", () => {
    // Without this the guard above could be widened to skip every metadata read.
    expect(rowWithMetadata({ producer: "claude-driver" }).metadata).toStrictEqual({
      producer: "claude-driver",
    });
  });
});
