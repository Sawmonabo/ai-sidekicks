// The composer's attachment strip, drawn from the staged list binding it is handed.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { StagedAttachmentsBinding } from "./hooks/useStagedAttachments.js";
import { AttachmentStrip } from "./AttachmentStrip.js";
import { sendingEntry } from "./ingest-entry.test-support.js";

/** A binding holding `entries`, whose acts do nothing: the strip only draws it. */
function bindingHolding(
  entries: StagedAttachmentsBinding["snapshot"]["entries"],
): StagedAttachmentsBinding {
  const ignore = (): void => undefined;
  return {
    snapshot: { entries, publishedAtMilliseconds: 0 },
    attachFiles: ignore,
    retry: ignore,
    abandon: ignore,
  };
}

describe("the composer's attachment strip", () => {
  it("is absent while the message carries nothing", () => {
    const { container } = render(
      <AttachmentStrip stagedAttachments={bindingHolding([])} isDraggingFiles={false} />,
    );
    expect(container.querySelector(".meridian-composer-attachments")).toBeNull();
  });

  it("puts an attached file on the strip under the name it was declared with", () => {
    const { container } = render(
      <AttachmentStrip
        stagedAttachments={bindingHolding([
          sendingEntry("ingesting", { declaredName: "notes.md" }),
        ])}
        isDraggingFiles={false}
      />,
    );
    const strip = container.querySelector(".meridian-composer-attachments");
    expect(strip?.textContent).toContain("notes.md");
    // A figure, never a gate.
    expect(strip?.textContent).toContain("1 of 10 attached");
  });

  it("carries its name on an element that can hold one", () => {
    // `aria-label` on a generic `div` reaches no assistive technology. The accessibility tier
    // cannot stand in: `aria-prohibited-attr` is outside the WCAG A/AA tag set it runs.
    const { container } = render(
      <AttachmentStrip
        stagedAttachments={bindingHolding([sendingEntry("ingesting")])}
        isDraggingFiles={false}
      />,
    );
    const strip = container.querySelector(".meridian-composer-attachments");

    expect(strip?.tagName).toBe("SECTION");
    expect(strip?.getAttribute("aria-label")).toBe("Attachments on this message");
  });
});
