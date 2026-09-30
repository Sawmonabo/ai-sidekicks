// The composer registers the `attachment` card, and the body it mounts is the composer's own
// `AttachmentCard`, so an unresolved marker reads the same in the transcript and the strip.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { INGEST_STALL_DISCLOSURE_MS } from "../attachment-caps.js";
import type { AttachmentIngestEntry } from "../attachment-shapes.js";

import {
  InlineCardRegistry,
  inlineCardRegistry,
  type AttachmentInlineCardProps,
} from "@renderer/registries/inline-cards/inline-card-registry.js";
import { registerComposerInlineCards } from "../../contributions/inline-cards.js";
import { InlineAttachmentCard } from "./InlineAttachmentCard.js";

const CARD: AttachmentInlineCardProps = {
  kind: "attachment",
  attachment: { attachmentId: "artifact-4" },
};

/** When the stream opened and last moved. */
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
  /** A registry this case owns; the registrar writes only what it is handed. */
  function fill(): InlineCardRegistry {
    const registry = new InlineCardRegistry();
    registerComposerInlineCards(registry);
    return registry;
  }

  it("fills the transcript's attachment card body", () => {
    const registry = fill();
    expect(registry.bodyFor("attachment")?.owner).toBe("composer");
    expect(registry.registeredCardKinds()).toContain("attachment");
  });

  it("renders through the registry the transcript reaches it by", () => {
    const registry = fill();
    const { container } = render(<>{registry.render(CARD)}</>);
    expect(container.querySelector(".meridian-attachment-card")).not.toBeNull();
  });

  it("negative control: an empty registry answers nothing", () => {
    // Without this, the cases above would pass over a registry that answered from elsewhere.
    expect(new InlineCardRegistry().bodyFor("attachment")).toBeUndefined();
  });

  it("writes the registry it is given and never the process-wide one", () => {
    // A body that reached the process-wide registry would render correctly and still leak.
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
    // Progress is stamped after the card mounts, so an instant frozen at mount could never
    // disclose a stall; the instant arrives with the reading.
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
    // `ingestCeilingRemainingMs` subtracts `openedAtMilliseconds` from the instant, so a
    // mount-frozen one never moved and, captured before the stream opened, went negative. One
    // upload at two instants must give two remainders, the later one smaller.
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
    // Neither is negative, which is what a pre-open subtraction produced.
    expect(earlier).not.toContain("-");
    expect(later).not.toContain("-");
  });

  it("negative control: an upload that has not gone quiet discloses nothing", () => {
    // Without this, a card that disclosed the ceiling unconditionally would pass.
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
