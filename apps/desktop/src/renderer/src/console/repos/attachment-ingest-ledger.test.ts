// The ledger: declared order, and the stamp a continuation checks itself against.
//
// Driven directly, with no bridge and no client — everything here settles before it
// returns, which is exactly what makes this module separable from the one that calls
// across a seam. The stamp cases are the mechanism the ingest client's abandonment
// guard rests on, stated once here at the seam that owns it.

import { describe, expect, it } from "vitest";

import { AttachmentIngestLedger } from "./attachment-ingest-ledger.js";
import { attachmentSourceFrom, type AttachmentIngestEntry } from "./attachment-model.js";

/** One source over an empty payload: these cases are about the record, not the bytes. */
function sourceNamed(localId: string): ReturnType<typeof attachmentSourceFrom> {
  return attachmentSourceFrom({
    localId,
    declaredName: `${localId}.md`,
    payload: new Blob([new Uint8Array(0)]),
  });
}

/** A ledger holding the named attachments, in that order. */
function ledgerHolding(...localIds: readonly string[]): AttachmentIngestLedger {
  const ledger = new AttachmentIngestLedger();
  for (const localId of localIds) {
    ledger.declare(sourceNamed(localId));
  }
  return ledger;
}

function declaredOrderOf(ledger: AttachmentIngestLedger): readonly string[] {
  return ledger.snapshot.map((entry) => entry.declared.localId);
}

/** One entry rewritten into a new state, the way the client rewrites it. */
function moveTo(entry: AttachmentIngestEntry, state: AttachmentIngestEntry["state"]) {
  return { ...entry, state };
}

describe("ingest ledger — declared order is the record", () => {
  it("round-trips a participant's reordering, which the reference must preserve", () => {
    const ledger = ledgerHolding("first", "second");
    ledger.reorder("second", 0);
    expect(declaredOrderOf(ledger)).toStrictEqual(["second", "first"]);
  });

  it("clamps a reorder inside the carrier rather than dropping the attachment", () => {
    const ledger = ledgerHolding("first", "second");
    ledger.reorder("first", 99);
    expect(declaredOrderOf(ledger)).toStrictEqual(["second", "first"]);
  });

  it("takes the position with the attachment when one is removed", () => {
    const ledger = ledgerHolding("first", "second");
    ledger.remove("first");
    expect(declaredOrderOf(ledger)).toStrictEqual(["second"]);
    expect(ledger.holds("first")).toBe(false);
  });

  it("negative control: a local id nobody declared moves nothing", () => {
    // Without this, the cases above would pass over a ledger that answered every call
    // by rebuilding its order from scratch.
    const ledger = ledgerHolding("first", "second");
    ledger.reorder("third", 0);
    ledger.remove("third");
    expect(declaredOrderOf(ledger)).toStrictEqual(["first", "second"]);
  });

  it("names only the attachments an ingest has actually minted", () => {
    const ledger = ledgerHolding("first", "second");
    const second = ledger.current("second");
    expect(second).toBeDefined();
    if (second !== undefined) {
      ledger.write("second", {
        ...second,
        state: "complete",
        derived: {
          artifactId: "artifact-9",
          normalizedName: "second.md",
          derivedMediaType: "text/markdown",
          derivedSizeBytes: 0,
        },
      });
    }
    // `first` never completed, so it names nothing: an artifact id is what an ingest
    // mints, and there is nothing to put in the reference before then.
    expect(ledger.artifactIds()).toStrictEqual(["artifact-9"]);
  });
});

describe("ingest ledger — the stamp a continuation checks against", () => {
  it("returns the entry when nothing has touched it", () => {
    const ledger = ledgerHolding("first");
    const stamp = ledger.stamp("first");
    expect(stamp).toBeDefined();
    if (stamp !== undefined) {
      expect(ledger.currentIfUnchanged("first", stamp)?.declared.localId).toBe("first");
    }
  });

  it("withholds the entry once a state change has been written", () => {
    const ledger = ledgerHolding("first");
    const stamp = ledger.stamp("first");
    const entry = ledger.current("first");
    expect(stamp).toBeDefined();
    if (stamp !== undefined && entry !== undefined) {
      ledger.write("first", moveTo(entry, "abandoned"));
      expect(ledger.currentIfUnchanged("first", stamp)).toBeUndefined();
    }
  });

  it("withholds it after a rewrite that ends where it began", () => {
    // The case a state comparison alone cannot see. An entry moved and moved back is
    // not the entry the continuation captured — its ingest identity, its ledger, or
    // its refusal may all have changed underneath — and the generation is what says so.
    const ledger = ledgerHolding("first");
    const stamp = ledger.stamp("first");
    const entry = ledger.current("first");
    expect(stamp).toBeDefined();
    if (stamp !== undefined && entry !== undefined) {
      ledger.write("first", moveTo(entry, "ingesting"));
      ledger.write("first", moveTo(entry, "declared"));
      expect(ledger.current("first")?.state).toBe("declared");
      expect(ledger.currentIfUnchanged("first", stamp)).toBeUndefined();
    }
  });

  it("withholds it once the attachment is gone entirely", () => {
    const ledger = ledgerHolding("first");
    const stamp = ledger.stamp("first");
    expect(stamp).toBeDefined();
    if (stamp !== undefined) {
      ledger.remove("first");
      expect(ledger.currentIfUnchanged("first", stamp)).toBeUndefined();
    }
  });

  it("withholds it once the ledger is disposed", () => {
    const ledger = ledgerHolding("first");
    const stamp = ledger.stamp("first");
    expect(stamp).toBeDefined();
    if (stamp !== undefined) {
      ledger.dispose();
      expect(ledger.currentIfUnchanged("first", stamp)).toBeUndefined();
    }
  });

  it("negative control: a reorder is not a change to any entry", () => {
    // Without this, the cases above would pass over a check that answered `undefined`
    // for everything — and every continuation would stop on the first publish.
    const ledger = ledgerHolding("first", "second");
    const stamp = ledger.stamp("first");
    expect(stamp).toBeDefined();
    if (stamp !== undefined) {
      ledger.reorder("second", 0);
      expect(ledger.currentIfUnchanged("first", stamp)).toBeDefined();
    }
  });

  it("has no stamp for an attachment nobody declared", () => {
    expect(new AttachmentIngestLedger().stamp("first")).toBeUndefined();
  });
});
