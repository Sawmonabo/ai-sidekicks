// The ledger: declared order, and the stamp a continuation checks itself against. Driven
// directly with no bridge or client; the stamp cases are the mechanism the client's abandonment
// guard rests on.

import type { ArtifactId } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { AttachmentIngestEntries } from "./attachment-ingest-entries.js";
import { attachmentSourceFrom, type AttachmentIngestEntry } from "./attachment-shapes.js";

/** One source over an empty payload: these cases are about the record, not the bytes. */
function sourceNamed(localId: string): ReturnType<typeof attachmentSourceFrom> {
  return attachmentSourceFrom({
    localId,
    declaredName: `${localId}.md`,
    payload: new Blob([new Uint8Array(0)]),
  });
}

/** A ledger holding the named attachments, in that order. */
function ledgerHolding(...localIds: readonly string[]): AttachmentIngestEntries {
  const ledger = new AttachmentIngestEntries();
  for (const localId of localIds) {
    ledger.declare(sourceNamed(localId));
  }
  return ledger;
}

function declaredOrderOf(ledger: AttachmentIngestEntries): readonly string[] {
  return ledger.snapshot.map((entry) => entry.declared.localId);
}

/** One entry rewritten into a new state, the way the client rewrites it. */
function moveTo(entry: AttachmentIngestEntry, state: AttachmentIngestEntry["state"]) {
  return { ...entry, state };
}

describe("ingest ledger — declared order is the record", () => {
  it("takes the position with the attachment when one is removed", () => {
    const ledger = ledgerHolding("first", "second");
    ledger.remove("first");
    expect(declaredOrderOf(ledger)).toStrictEqual(["second"]);
    expect(ledger.holds("first")).toBe(false);
  });

  it("negative control: a local id nobody declared moves nothing", () => {
    // Without this the cases above would pass over a ledger rebuilding its order every call.
    const ledger = ledgerHolding("first", "second");
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
          artifactId: "artifact-9" as ArtifactId,
          fileName: "second.md",
          mimeType: "text/markdown",
          sizeBytes: 0,
        },
      });
    }
    // `first` never completed, so it names nothing: an ingest mints the artifact id.
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
    // A state comparison alone cannot see this: an entry moved and moved back is not the entry
    // the continuation captured, and the generation says so.
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

  it("negative control: another attachment's arrival is not a change to this entry", () => {
    // Without this the cases above would pass over a check answering `undefined` for everything.
    const ledger = ledgerHolding("first", "second");
    const stamp = ledger.stamp("first");
    expect(stamp).toBeDefined();
    if (stamp !== undefined) {
      ledger.declare(sourceNamed("third"));
      expect(ledger.currentIfUnchanged("first", stamp)).toBeDefined();
    }
  });

  it("has no stamp for an attachment nobody declared", () => {
    expect(new AttachmentIngestEntries().stamp("first")).toBeUndefined();
  });
});
