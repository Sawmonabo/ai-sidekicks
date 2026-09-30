// The stamp a continuation checks itself against, driven directly with no bridge or client: the
// mechanism the client's abandonment guard rests on.

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

/** One entry rewritten into a new state, the way the client rewrites it. */
function moveTo(entry: AttachmentIngestEntry, state: AttachmentIngestEntry["state"]) {
  return { ...entry, state };
}

describe("ingest ledger — the stamp a continuation checks against", () => {
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
});
