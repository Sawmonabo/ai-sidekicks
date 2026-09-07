// Where a move lands, and the one case where the honest answer is "nowhere".
//
// The refusal at the ends is the case worth pinning: a clamp would answer with the
// position the attachment is already at, and the caller would then announce a move
// nobody made — the row at the top of the list saying "moved to position 1" on every
// press of the up arrow.

import { describe, expect, it } from "vitest";

import {
  attachmentPositionOf,
  attachmentReorderAnnouncement,
  attachmentReorderHandleLabel,
  movedAttachmentPosition,
} from "./attachment-reorder.js";
import { type AttachmentIngestEntry } from "./attachment-shapes.js";
import { threeAttachmentCarrier } from "./carrier-entries.test-support.js";

const CARRIER: readonly AttachmentIngestEntry[] = threeAttachmentCarrier();

describe("attachment reorder — finding an attachment's position", () => {
  it("answers the declared position, counting from zero as the ledger does", () => {
    expect(attachmentPositionOf(CARRIER, "attachment-2")).toBe(1);
  });

  it("negative control: an attachment the carrier does not hold has no position", () => {
    // Without this a `findIndex` returning -1 would read as "position minus one" and
    // a move would splice against it.
    expect(attachmentPositionOf(CARRIER, "attachment-9")).toBeUndefined();
  });
});

describe("attachment reorder — where one keyboard step lands", () => {
  it("moves one position in each direction", () => {
    expect(movedAttachmentPosition(1, -1, 3)).toBe(0);
    expect(movedAttachmentPosition(1, 1, 3)).toBe(2);
  });

  it("refuses rather than clamping at either end", () => {
    expect(movedAttachmentPosition(0, -1, 3)).toBeUndefined();
    expect(movedAttachmentPosition(2, 1, 3)).toBeUndefined();
  });

  it("negative control: a single-attachment carrier can move in neither direction", () => {
    expect(movedAttachmentPosition(0, -1, 1)).toBeUndefined();
    expect(movedAttachmentPosition(0, 1, 1)).toBeUndefined();
  });
});

describe("attachment reorder — what is said out loud", () => {
  it("names the attachment and both halves of the position, counting from one", () => {
    expect(attachmentReorderAnnouncement("second.md", 2, 3)).toBe(
      "second.md moved to position 3 of 3.",
    );
  });

  it("names the same two halves on the grip, and both ways of moving it", () => {
    const label = attachmentReorderHandleLabel("second.md", 1, 3);
    expect(label).toContain("second.md");
    expect(label).toContain("position 2 of 3");
    expect(label).toContain("arrow keys");
  });
});
