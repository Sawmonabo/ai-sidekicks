// The attachment card in the ledger, and the seat it fills.
//
// Two claims: the seat is filled by this family, and the body it mounts is the SAME
// `AttachmentCard` the attachment surface renders rather than a second one written for
// the timeline. The second is checkable because that card carries its own classes, and
// it matters because an unresolved marker is read for details two renderers would drift
// on — which of the six causes, and what the remedy is.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { INGEST_STALL_DISCLOSURE_MS } from "../../core/index.js";
import type { AttachmentIngestEntry } from "../../repos/attachments/attachment-shapes.js";

import {
  inlineCardBody,
  inlineCardSeatRegistry,
  type AttachmentInlineCardProps,
} from "../../seats/index.js";
import { InlineAttachmentCard, registerInlineAttachmentCardBody } from "./InlineAttachmentCard.js";

const CARD: AttachmentInlineCardProps = {
  kind: "attachment",
  attachment: { attachmentId: "artifact-4" },
};

/** When the stream opened and last moved. Every age below is read against this one. */
const UPLOAD_OPENED_AT = 1_800_000_000_000;

/** One upload in flight whose last acknowledged chunk was the moment it opened. */
function quietUpload(): AttachmentIngestEntry {
  return {
    state: "ingesting",
    receivedBytes: 1024,
    ingestId: "ingest-1",
    derived: undefined,
    refusal: undefined,
    disposition: undefined,
    openedAtMilliseconds: UPLOAD_OPENED_AT,
    lastProgressAtMilliseconds: UPLOAD_OPENED_AT,
    declared: {
      localId: "local-1",
      declaredName: "notes.md",
      byteLength: 4096,
      declaredMediaType: "text/markdown",
    },
    payload: new Blob(["notes"]),
  };
}

afterEach(() => {
  inlineCardSeatRegistry.unregister("attachment");
});

describe("inline attachment card — the seat", () => {
  it("fills the ledger's attachment card body", () => {
    registerInlineAttachmentCardBody();
    expect(inlineCardBody("attachment")?.owner).toBe("repos");
    expect(inlineCardSeatRegistry.registeredCardKinds()).toContain("attachment");
  });

  it("renders through the registry the ledger reaches it by", () => {
    registerInlineAttachmentCardBody();
    const { container } = render(<>{inlineCardSeatRegistry.render(CARD)}</>);
    expect(container.querySelector(".meridian-attachment-card")).not.toBeNull();
  });

  it("negative control: the registry answers nothing before the body is registered", () => {
    expect(inlineCardBody("attachment")).toBeUndefined();
  });
});

describe("inline attachment card — one body, and the honest absence", () => {
  it("mounts the attachment surface's own card rather than a second one", () => {
    const { container } = render(<InlineAttachmentCard card={CARD} />);
    expect(container.querySelector(".meridian-attachment")).not.toBeNull();
  });

  it("says the attachment has not been resolved, and never that it is gone", () => {
    const { container } = render(<InlineAttachmentCard card={CARD} />);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.querySelector(".meridian-attachment__unresolved")).toBeNull();
  });

  it("negative control: a supplied reading displaces the unread arm", () => {
    // The seat carries identity only today. When the typed reference lands, this is the
    // arm the daemon's answer arrives on, and the case proves the seam is real rather
    // than decorative.
    const { container } = render(
      <InlineAttachmentCard
        card={CARD}
        reading={{ kind: "unresolved", attachmentId: "artifact-4", cause: "over_cap" }}
        nowMilliseconds={UPLOAD_OPENED_AT}
      />,
    );
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
    expect(container.querySelector(".meridian-attachment__unresolved")).not.toBeNull();
  });
});

describe("inline attachment card — the instant an age is read against", () => {
  it("discloses a stalled upload, which a mount-frozen instant could never do", () => {
    // The defect, exercised. The card used to capture `Date.now()` at MOUNT and hand
    // that to the card for the life of the mount. `isIngestStalled` compares the
    // instant against `lastProgressAtMilliseconds + INGEST_STALL_DISCLOSURE_MS`, and
    // that progress is stamped by the ingest driver AFTER the card mounted — so the
    // comparison could never be true, and the disclosure this threshold exists to
    // produce was dead on this surface. The instant now arrives with the reading, from
    // the producer that took both, so a later one discloses.
    const { container } = render(
      <InlineAttachmentCard
        card={CARD}
        reading={{ kind: "ingesting", entry: quietUpload() }}
        nowMilliseconds={UPLOAD_OPENED_AT + INGEST_STALL_DISCLOSURE_MS + 1}
      />,
    );

    const note = container.querySelector(".meridian-attachment__note");
    expect(note?.textContent).toContain("gone quiet");
  });

  it("spends the instant it was handed, so the ceiling remainder actually falls", () => {
    // The second figure the frozen instant broke. `ingestCeilingRemainingMs` subtracts
    // `openedAtMilliseconds` from the instant, so a mount-frozen one never moved — and
    // where it was captured BEFORE the stream opened the subtraction went negative and
    // the card reported more time remaining than the ceiling allows. The claim here is
    // that the figure is a function of what the producer handed over: one upload, two
    // instants, two remainders, and the later one is smaller.
    const noteAt = (nowMilliseconds: number): string => {
      const { container, unmount } = render(
        <InlineAttachmentCard
          card={CARD}
          reading={{ kind: "ingesting", entry: quietUpload() }}
          nowMilliseconds={nowMilliseconds}
        />,
      );
      const text = container.querySelector(".meridian-attachment__note")?.textContent ?? "";
      unmount();
      return text;
    };

    const earlier = noteAt(UPLOAD_OPENED_AT + INGEST_STALL_DISCLOSURE_MS + 1);
    const later = noteAt(UPLOAD_OPENED_AT + INGEST_STALL_DISCLOSURE_MS + 60_001);
    expect(earlier).not.toBe("");
    expect(later).not.toBe(earlier);
    // And neither is negative, which is what the pre-open subtraction produced.
    expect(earlier).not.toContain("-");
    expect(later).not.toContain("-");
  });

  it("negative control: an upload that has not gone quiet discloses nothing", () => {
    // Without this the cases above would pass over a card that disclosed the ceiling
    // unconditionally, which reports a stall for every upload in flight.
    const { container } = render(
      <InlineAttachmentCard
        card={CARD}
        reading={{ kind: "ingesting", entry: quietUpload() }}
        nowMilliseconds={UPLOAD_OPENED_AT + 1}
      />,
    );

    expect(container.querySelector(".meridian-attachment__note")).toBeNull();
  });
});
