// The ingest vocabulary both browser cards read, held to its two promises.
//
// The progress sentence shows what arrived AGAINST what was declared — a single
// figure would hide which of the two a stalled transfer is stuck on — and the meter
// never reports completion it cannot establish, which is what an unknown or absent
// denominator is.

import { describe, expect, it } from "vitest";

import {
  BROWSER_INGEST_REMEDIES,
  formatIngestProgress,
  ingestFillWidth,
  ingestRemedySentence,
  isIngestRangeDeterminate,
} from "./artifact-ingest.js";

describe("the ingest range — one predicate every reading of the meter derives from", () => {
  it("takes a finite numerator against a finite, positive denominator", () => {
    expect(isIngestRangeDeterminate(0, 1024)).toBe(true);
    expect(isIngestRangeDeterminate(4096, 1024)).toBe(true);
  });

  it("refuses every denominator there is nothing to divide by", () => {
    expect(isIngestRangeDeterminate(100, 0)).toBe(false);
    expect(isIngestRangeDeterminate(100, -1)).toBe(false);
    expect(isIngestRangeDeterminate(100, Number.NaN)).toBe(false);
    expect(isIngestRangeDeterminate(100, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isIngestRangeDeterminate(Number.NaN, 1024)).toBe(false);
  });

  it("negative control: nothing about it is a reading of how far along the transfer is", () => {
    // A predicate that also demanded progress would take the scale away from a
    // transfer that has begun and delivered nothing yet, which is a known range.
    expect(isIngestRangeDeterminate(0, 1024)).toBe(isIngestRangeDeterminate(512, 1024));
  });
});

describe("ingest progress — both figures, through the one chokepoint", () => {
  it("renders received against declared", () => {
    expect(formatIngestProgress(1024, 4096, "en-US")).toBe("1.0 KiB of 4.0 KiB");
  });

  it("scales each side independently, so a small share of a large total still reads", () => {
    expect(formatIngestProgress(512, 1048576, "en-US")).toBe("512 B of 1.0 MiB");
  });

  it("names an undeclared total in words rather than printing it as zero", () => {
    // "512 B of 0 B" reads as a producer that declared nothing having declared
    // nothing to send, beside a bar the same predicate has already reset to empty.
    // The quantity's own separator is matched as whitespace rather than typed:
    // `Intl` joins a figure to its unit with a narrow no-break space, and an
    // expectation carrying an ordinary one asserts how a string was typed.
    expect(formatIngestProgress(512, 0, "en-US")).toMatch(/^512\sB of an undeclared total$/u);
    expect(formatIngestProgress(512, Number.NaN, "en-US")).toMatch(
      /^512\sB of an undeclared total$/u,
    );
  });

  it("negative control: it is not one figure, and not a percentage", () => {
    // Without this, the two cases above would pass over an implementation that
    // rendered only the total, or only a ratio — either of which loses exactly the
    // fact the row exists to show.
    const sentence = formatIngestProgress(1024, 4096, "en-US");
    expect(sentence.split("of")).toHaveLength(2);
    expect(sentence).not.toContain("%");
  });
});

describe("ingest meter fill — never completion it cannot establish", () => {
  it("reports the share that arrived", () => {
    expect(ingestFillWidth(512, 1024)).toBe("50%");
  });

  it("clamps a received figure past the declared total", () => {
    expect(ingestFillWidth(4096, 1024)).toBe("100%");
  });

  it("renders empty for an unusable denominator rather than full", () => {
    expect(ingestFillWidth(100, 0)).toBe("0%");
    expect(ingestFillWidth(100, Number.NaN)).toBe("0%");
    expect(ingestFillWidth(Number.POSITIVE_INFINITY, 1024)).toBe("0%");
  });

  it("negative control: a zero denominator is not treated as a finished transfer", () => {
    // The natural bug here is `received >= declared ? "100%"`, which reports a
    // completed download for a total nobody supplied. This case fails on it.
    expect(ingestFillWidth(0, 0)).not.toBe("100%");
    expect(ingestFillWidth(1, 0)).not.toBe("100%");
  });
});

describe("ingest remedies — one sentence per arm", () => {
  it("answers for every remedy in the closed set", () => {
    expect(BROWSER_INGEST_REMEDIES).toHaveLength(3);
    for (const remedy of BROWSER_INGEST_REMEDIES) {
      expect(ingestRemedySentence(remedy)).not.toBe("");
    }
  });

  it("says the bytes survive a capacity refusal", () => {
    expect(ingestRemedySentence("retry-later")).toContain("not lost");
  });

  it("negative control: the three arms do not share a sentence", () => {
    // A table that fell back to one string would pass every case above.
    const sentences = BROWSER_INGEST_REMEDIES.map((remedy) => ingestRemedySentence(remedy));
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});
