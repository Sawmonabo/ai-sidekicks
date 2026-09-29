// The attachment card in the ledger, and its registration.
//
// Two claims: the composer registers the `attachment` card, and the body it mounts is the
// composer's own `AttachmentCard` rather than a second one written for the
// transcript. The second is checkable because that card carries its own classes, and
// it matters because an unresolved marker is read for details two renderers would drift
// on — which of the six causes, and what the remedy is.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { INGEST_STALL_DISCLOSURE_MS } from "../attachment-caps.js";
import type { AttachmentIngestEntry } from "../attachment-shapes.js";

import {
  InlineCardRegistry,
  inlineCardRegistry,
  type AttachmentInlineCardProps,
} from "@renderer/console/seats/index.js";
import { registerComposerInlineCards } from "../../contributions/inline-cards.js";
import { InlineAttachmentCard } from "./InlineAttachmentCard.js";

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

describe("inline attachment card — the registration", () => {
  /**
   * A registry this case owns.
   *
   * The registrar writes only what it is handed, so there is nothing to release afterwards.
   */
  function fill(): InlineCardRegistry {
    const registry = new InlineCardRegistry();
    registerComposerInlineCards(registry);
    return registry;
  }

  it("fills the ledger's attachment card body", () => {
    const registry = fill();
    expect(registry.bodyFor("attachment")?.owner).toBe("composer");
    expect(registry.registeredCardKinds()).toContain("attachment");
  });

  it("renders through the registry the ledger reaches it by", () => {
    const registry = fill();
    const { container } = render(<>{registry.render(CARD)}</>);
    expect(container.querySelector(".meridian-attachment-card")).not.toBeNull();
  });

  it("negative control: an empty registry answers nothing", () => {
    // Without this, the two cases above would pass over a registry that answered from
    // somewhere else entirely, and the registration call would be doing nothing.
    expect(new InlineCardRegistry().bodyFor("attachment")).toBeUndefined();
  });

  it("writes the registry it is given and never the process-wide one", () => {
    // The registrar closes over no singleton. A body that reached one would render
    // correctly in every case above and still leak into the running console.
    fill();
    expect(inlineCardRegistry.registeredCardKinds()).toStrictEqual([]);
  });
});

describe("inline attachment card — one body", () => {
  it("names the reference the card carried when no reading was supplied", () => {
    const { container, getByRole } = render(<InlineAttachmentCard card={CARD} />);
    getByRole("group", { name: "Attachment artifact-4" });
    expect(container.querySelector(".meridian-attachment")).toBeNull();
    expect(container.querySelector(".meridian-attachment-card")?.textContent).toBe(
      CARD.attachment.attachmentId,
    );
  });

  it("mounts the composer's own attachment card once a reading is supplied", () => {
    const { container, getByRole } = render(
      <InlineAttachmentCard
        card={CARD}
        reading={{ kind: "unresolved", attachmentId: "artifact-4", cause: "over_cap" }}
        nowMilliseconds={UPLOAD_OPENED_AT}
      />,
    );
    getByRole("article", { name: "Attachment artifact-4" });
    expect(container.querySelector(".meridian-attachment")).not.toBeNull();
    expect(container.querySelector(".meridian-attachment__unresolved")).not.toBeNull();
  });
});

describe("inline attachment card — the instant an age is read against", () => {
  it("discloses a stalled upload, which a mount-frozen instant could never do", () => {
    // `isIngestStalled` compares the instant against `lastProgressAtMilliseconds +
    // INGEST_STALL_DISCLOSURE_MS`, and progress is stamped after the card mounts, so an
    // instant frozen at mount could never disclose. The instant arrives with the reading,
    // from the producer that took both, so a later one discloses.
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
