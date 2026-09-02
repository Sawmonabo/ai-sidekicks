// The capture card's two prohibitions are the cases worth writing.
//
// A capture is never rendered inline as trusted markup, and the console never runs a
// second validation on browser bytes. Both are properties of what the card does NOT
// do, so both are asserted against elements and behaviour that would exist if it
// did.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../core/index.js";
import { BrowserCaptureCard, type BrowserCaptureCardProps } from "./CaptureCard.js";

const BASE: BrowserCaptureCardProps = {
  captureName: "staging build, checkout step",
  scope: "viewport",
  mediaType: "image/png",
  ingest: { status: "stored", artifactId: "artifact-4f21", byteLength: 262144 },
};

function renderCapture(props: BrowserCaptureCardProps): HTMLElement {
  const { container } = render(<BrowserCaptureCard {...props} />);
  const card = container.querySelector("article");
  if (!(card instanceof HTMLElement)) {
    throw new Error("BrowserCaptureCard rendered no card");
  }
  return card;
}

describe("capture card — the produced object, collapsed to a line", () => {
  it("names itself, its scope, and the type the pipeline reported", () => {
    const card = renderCapture(BASE);
    expect(card.getAttribute("aria-label")).toContain("staging build");
    expect(card.textContent).toContain("Viewport");
    expect(card.textContent).toContain("image/png");
  });

  it("wears the wire's provenance signature on the type and the id", () => {
    const card = renderCapture(BASE);
    const monoText = [...card.querySelectorAll(".meridian-figure--wire, .meridian-chip--mono")]
      .map((node) => node.textContent ?? "")
      .join(" ");
    expect(monoText).toContain("image/png");
    expect(monoText).toContain("artifact-4f21");
  });

  it("renders the stored size through the console's one byte formatter", () => {
    // A non-breaking space joins a figure to its unit, and whole hundreds drop the
    // fraction digit — both are the chokepoint's rules, asserted as it writes them
    // rather than as they look.
    expect(renderCapture(BASE).textContent).toContain("256\u00A0KiB");
  });
});

describe("capture card — never inline markup", () => {
  it("renders no image element and no embedded source", () => {
    const card = renderCapture(BASE);
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector("[src]")).toBeNull();
    expect(card.innerHTML).not.toContain("data:image");
  });

  it("offers the preview only where the caller supplied a fetch", () => {
    const withoutPreview = renderCapture(BASE);
    expect(withoutPreview.textContent).not.toContain("Open preview");
    const onOpenPreview = vi.fn();
    const withPreview = renderCapture({ ...BASE, onOpenPreview });
    const control = [...withPreview.querySelectorAll("button")].find(
      (button) => button.textContent === "Open preview",
    );
    control?.click();
    expect(onOpenPreview).toHaveBeenCalledTimes(1);
  });

  it("negative control: an absent preview route draws no inert control", () => {
    // Without this, the case above would pass over a card that always drew the
    // button and simply did nothing when it was pressed.
    expect(renderCapture(BASE).querySelectorAll("button")).toHaveLength(0);
  });
});

describe("capture card — the ingest states", () => {
  it("shows received against declared while bytes are moving", () => {
    const card = renderCapture({
      ...BASE,
      ingest: { status: "in-flight", receivedByteLength: 65536, declaredByteLength: 262144 },
    });
    expect(card.textContent).toContain("64.0\u00A0KiB of 256\u00A0KiB");
    expect(card.querySelector('[role="progressbar"]')?.getAttribute("aria-valuemax")).toBe(
      "262144",
    );
  });

  it("renders a refusal verbatim, with the remedy the producer supplied", () => {
    const card = renderCapture({
      ...BASE,
      ingest: {
        status: "refused",
        refusal: refuse(
          "ingest",
          "artifact.unsupported_media_type",
          "Scalable vector images are outside this node's allow-list.",
        ),
        remedy: "none",
      },
    });
    expect(card.textContent).toContain("artifact.unsupported_media_type");
    expect(card.textContent).toContain("outside this node's allow-list");
    expect(card.className).toContain("meridian-browser-card--refused");
  });

  it("says nobody asked, rather than that nothing happened", () => {
    const card = renderCapture({ ...BASE, ingest: { status: "not-checked" } });
    expect(card.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(card.textContent).not.toContain("No bytes");
  });

  it("negative control: the card runs no allow-list of its own", () => {
    // A card that checked the media type would refuse this one itself rather than
    // rendering it. The one validation path is the pipeline's.
    const card = renderCapture({ ...BASE, mediaType: "image/svg+xml" });
    expect(card.textContent).toContain("image/svg+xml");
    expect(card.className).not.toContain("meridian-browser-card--refused");
  });

  it("says where the full image is when the tool result could not carry it", () => {
    const card = renderCapture({ ...BASE, displacedFromToolResult: true });
    expect(card.textContent).toContain("The full capture is here");
  });
});
