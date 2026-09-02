// The attachment card in the ledger, and the seat it fills.
//
// Two claims: the seat is filled by this family, and the body it mounts is the SAME
// `AttachmentCard` the attachment surface renders rather than a second one written for
// the timeline. The second is checkable because that card carries its own classes, and
// it matters because an unresolved marker is read for details two renderers would drift
// on — which of the six causes, and what the remedy is.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  inlineCardBody,
  inlineCardSeatRegistry,
  type AttachmentInlineCardProps,
} from "../../workspace/index.js";
import { InlineAttachmentCard, registerInlineAttachmentCardBody } from "./InlineAttachmentCard.js";

const CARD: AttachmentInlineCardProps = {
  kind: "attachment",
  attachment: { attachmentId: "artifact-4" },
};

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
      />,
    );
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
    expect(container.querySelector(".meridian-attachment__unresolved")).not.toBeNull();
  });
});
