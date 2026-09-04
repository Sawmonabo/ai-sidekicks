// The download card's job is to be trustworthy about two things it does not do: it
// does not write where the page asked, and it does not enforce a size cap of its own.
//
// Both are absences, so both are asserted against what the card WOULD carry if it
// did — a locator built from the page's proposed name, and a refusal the card raised
// rather than rendered.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../core/index.js";
import { BrowserDownloadCard, type BrowserDownloadCardProps } from "./DownloadCard.js";

const BASE: BrowserDownloadCardProps = {
  proposedFileName: "quarterly-report.pdf",
  sourcePageLabel: "Staging dashboard",
  ingest: { status: "stored", artifactId: "artifact-91cd", byteLength: 5242880 },
};

function renderDownload(props: BrowserDownloadCardProps): HTMLElement {
  const { container } = render(<BrowserDownloadCard {...props} />);
  const card = container.querySelector("article");
  if (!(card instanceof HTMLElement)) {
    throw new Error("BrowserDownloadCard rendered no card");
  }
  return card;
}

const REFUSED_UNSTORABLE: BrowserDownloadCardProps = {
  ...BASE,
  ingest: {
    status: "refused",
    refusal: refuse("ingest", "artifact.too_large", "Larger than this node accepts."),
    remedy: "none",
  },
};

describe("download card — where the bytes went", () => {
  it("says the artifact store, and says it was not the page's destination", () => {
    const text = renderDownload(BASE).textContent ?? "";
    expect(text).toContain("artifact store");
    expect(text).toContain("never at the destination the page asked for");
  });

  it("renders the proposed name as text and as no locator at all", () => {
    const card = renderDownload(BASE);
    expect(card.textContent).toContain("quarterly-report.pdf");
    // The name the page chose reaches no attribute that could resolve to a file.
    expect(card.querySelector("[href]")).toBeNull();
    expect(card.querySelector("[src]")).toBeNull();
    expect(card.querySelector("[download]")).toBeNull();
  });

  it("reveals through a nullary callback, so no path crosses the boundary", () => {
    const onRevealInFileManager = vi.fn();
    const card = renderDownload({ ...BASE, onRevealInFileManager });
    const control = [...card.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").includes("Reveal"),
    );
    control?.click();
    expect(onRevealInFileManager).toHaveBeenCalledWith();
  });

  it("negative control: no reveal control exists without a callback", () => {
    // Without this, the case above would pass over a card that always drew the
    // control and quietly did nothing.
    expect(renderDownload(BASE).querySelectorAll("button")).toHaveLength(0);
  });
});

describe("download card — the ceiling is quoted, never minted", () => {
  /** The ceiling as it is rendered, or nothing where no bound was read. */
  function ceilingOf(props: BrowserDownloadCardProps): HTMLElement | null {
    return renderDownload(props).querySelector(".meridian-browser-card__ceiling");
  }

  /** The exact count the pipeline reported, off the ceiling's own wire figure. */
  function exactCountOf(ceiling: HTMLElement | null): string | null {
    return ceiling?.querySelector(".meridian-figure--wire")?.getAttribute("title") ?? null;
  }

  it("renders the pipeline's bound when it was read", () => {
    expect(ceilingOf({ ...BASE, ingestCeilingByteLength: 104857600 })?.textContent).toContain(
      "100\u00A0MiB",
    );
  });

  it("names no bound when none was read", () => {
    // Asserted on the ceiling ELEMENT rather than on the card's text: the stored size
    // is a byte figure too, so a text search would pass for the wrong reason.
    expect(ceilingOf(BASE)).toBeNull();
    expect(ceilingOf({ ...BASE, ingestCeilingByteLength: 104857600 })).not.toBeNull();
  });

  it("keeps the pipeline's exact count behind the rounded reading", () => {
    // 8,388,609 bytes is not representable in the scaled unit, so the visible text is
    // a reading of the bound rather than the bound. The count the pipeline reported
    // rides the figure's title, the way this card's stored size already does.
    const ceiling = ceilingOf({ ...BASE, ingestCeilingByteLength: 8388609 });
    expect(ceiling?.querySelector(".meridian-figure--wire")?.textContent).toBe("8.0\u00A0MiB");
    expect(exactCountOf(ceiling)).toBe("8388609");
  });

  it("negative control: two bounds that read alike are still told apart", () => {
    // Without this, the case above would pass over a title that merely echoed the
    // rounded text. The collision is the whole reason the exact count is carried: an
    // operator comparing two nodes' enforced limits sees one figure for two numbers.
    const larger = ceilingOf({ ...BASE, ingestCeilingByteLength: 8388609 });
    const smaller = ceilingOf({ ...BASE, ingestCeilingByteLength: 8388608 });
    expect(larger?.textContent).toBe(smaller?.textContent);
    expect(exactCountOf(larger)).not.toBe(exactCountOf(smaller));
  });

  it("negative control: an over-ceiling download is not refused by the card", () => {
    // The card compares nothing. A download larger than the stated ceiling still
    // renders as whatever the pipeline said it was — here, stored.
    const card = renderDownload({ ...BASE, ingestCeilingByteLength: 1024 });
    expect(card.className).not.toContain("meridian-browser-card--refused");
    expect(card.textContent).toContain("artifact-91cd");
  });
});

describe("download card — the destination is claimed in each arm's own tense", () => {
  it("claims the store in the past tense only once the pipeline has stored the bytes", () => {
    expect(renderDownload(BASE).textContent).toContain("Stored in this session");
  });

  it("names the store as an intention while nobody has asked what became of them", () => {
    const card = renderDownload({ ...BASE, ingest: { status: "not-checked" } });

    expect(card.textContent).toContain("Destined for this session");
    expect(card.textContent).not.toContain("Stored in this session");
  });

  it("names the store as an intention while the bytes are still arriving", () => {
    const card = renderDownload({
      ...BASE,
      ingest: { status: "in-flight", receivedByteLength: 1048576, declaredByteLength: 5242880 },
    });

    expect(card.textContent).toContain("Destined for this session");
    expect(card.textContent).not.toContain("Stored in this session");
  });

  it("negative control: a refusal is not told the bytes are in the store", () => {
    // The sentence this replaces rendered on every arm, so a refused download — and on
    // the `none` remedy, one the pipeline had said in terms it would not store — told
    // the operator the bytes were in the artifact store two lines above the refusal
    // that kept them out of it.
    const card = renderDownload(REFUSED_UNSTORABLE);

    expect(card.textContent).not.toContain("Stored in this session");
    expect(card.textContent).not.toContain("Destined for this session");
    expect(card.textContent).toContain("These bytes will not be stored.");
    expect(card.textContent).toContain("artifact.too_large");
  });
});

describe("download card — the ingest states", () => {
  it("shows received against declared, and marks the row as waiting", () => {
    const card = renderDownload({
      ...BASE,
      ingest: { status: "in-flight", receivedByteLength: 1048576, declaredByteLength: 5242880 },
    });
    expect(card.textContent).toContain("1.0 MiB of 5.0 MiB");
    expect(card.className).toContain("meridian-browser-card--waiting");
  });

  it("says the bytes survive a capacity refusal", () => {
    const card = renderDownload({
      ...BASE,
      ingest: {
        status: "refused",
        refusal: refuse(
          "ingest",
          "artifact.ingest_capacity_exhausted",
          "This node's ingest capacity is exhausted.",
        ),
        remedy: "retry-later",
      },
    });
    expect(card.textContent).toContain("artifact.ingest_capacity_exhausted");
    expect(card.textContent).toContain("not lost");
  });

  it("negative control: a refused row is not also drawn as waiting", () => {
    // The two modifiers carry different meanings — red for failed, amber for a
    // person is needed — and a card that stacked them would spend both hues on one
    // fact.
    const card = renderDownload(REFUSED_UNSTORABLE);
    expect(card.className).toContain("meridian-browser-card--refused");
    expect(card.className).not.toContain("meridian-browser-card--waiting");
  });
});
