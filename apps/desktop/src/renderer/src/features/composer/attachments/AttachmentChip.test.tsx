// What the chip puts on screen, as against what the fold decided.
//
// A SEPARATE SUITE FROM `composer-attachment-chip.test.ts`, which drives the fold: that
// one holds what the model SAYS, and neither of the two claims below is reachable from
// it. Both are about carriage — whether a sentence the model already carries reaches a
// person, and whether a control announces as the thing it measures — and a model test
// passes over a component that renders the right words into an attribute nobody reads.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { INGEST_ABANDON_COPY, INGEST_DISPOSITION_COPY } from "@renderer/console/repos/index.js";
import { AttachmentChip } from "./AttachmentChip.js";
import { composerAttachmentChip } from "./composer-attachment-chip.js";
import { derivedTruth, sendingEntry, settledEntry } from "./ingest-entry.test-support.js";

/** The instant a carrier published at. Fixed, so nothing here reads a clock. */
const PUBLISHED_AT = 1_000_000;

/** One chip, rendered over the real fold rather than over a hand-built model. */
function renderChip(entry: Parameters<typeof composerAttachmentChip>[0]): HTMLElement {
  const { container } = render(
    <AttachmentChip
      chip={composerAttachmentChip(entry, PUBLISHED_AT)}
      onRetry={() => {}}
      onAbandon={() => {}}
    />,
  );
  return container;
}

describe("the attachment chip's progress bar", () => {
  it("names the file whose upload it measures", () => {
    // A carrier of several files announces several bars, so each is named for its file.
    const container = renderChip(
      sendingEntry("ingesting", {
        declaredName: "notes.md",
        byteLength: 1000,
        receivedBytes: 250,
      }),
    );
    const progress = container.querySelector("progress");

    expect(progress?.getAttribute("aria-label")).toBe("Upload progress for notes.md");
    // And the amount rides `value` over `max`, where a progress element carries it.
    expect(progress?.getAttribute("value")).toBe("0.25");
    expect(progress?.getAttribute("max")).toBe("1");
  });

  it("negative control: a settled entry draws no bar to name", () => {
    // Without this the case above would pass over a chip that drew a bar on every
    // state, which reads as an upload about to start on one that already failed.
    const container = renderChip(
      sendingEntry("refused", {
        declaredName: "notes.md",
        refusal: { code: "artifact.too_large", detail: "The payload is past the bound." },
      }),
    );

    expect(container.querySelector("progress")).toBeNull();
  });
});

describe("the attachment chip's remedies", () => {
  it("renders what a refusal recommends as text a person can read", () => {
    // The recommendation is text, not a control's `title`: a tooltip is never seen by a
    // touch user, is reached by a keyboard user only with a pointer they are not using,
    // and is announced reliably by no assistive technology this console can name.
    const container = renderChip(
      sendingEntry("refused", {
        declaredName: "notes.bin",
        refusal: {
          code: "artifact.unsupported_media_type",
          detail: "The payload's type is outside this deployment's allow-list.",
        },
        disposition: "restart",
      }),
    );
    const text = container.textContent ?? "";

    expect(text).toContain(INGEST_DISPOSITION_COPY.restart);
    // The code and the daemon's own sentence stay beside it, unparaphrased.
    expect(text).toContain("artifact.unsupported_media_type");
    expect(text).toContain("outside this deployment's allow-list");
    // And nothing is left carrying the sentence as a tooltip instead.
    const titled = [...container.querySelectorAll("[title]")].map((element) =>
      element.getAttribute("title"),
    );
    expect(titled).not.toContain(INGEST_DISPOSITION_COPY.restart);
  });

  it("says what cancelling does beside the control that offers it", () => {
    const container = renderChip(
      sendingEntry("ingesting", { declaredName: "notes.md", receivedBytes: 250 }),
    );
    const text = container.textContent ?? "";

    expect(text).toContain("Cancel");
    expect(text).toContain(INGEST_ABANDON_COPY);
    const titled = [...container.querySelectorAll("[title]")].map((element) =>
      element.getAttribute("title"),
    );
    expect(titled).not.toContain(INGEST_ABANDON_COPY);
  });

  it("negative control: a chip with no refusal and no abandon carries neither line", () => {
    // Both sentences are consequences of controls, so a chip offering neither says
    // neither — otherwise the cases above would pass over prose rendered always.
    const container = renderChip(sendingEntry("declared", { declaredName: "notes.md" }));
    const settled = render(
      <AttachmentChip
        chip={composerAttachmentChip(
          settledEntry("complete", { declaredName: "notes.md", derived: derivedTruth() }),
          PUBLISHED_AT,
        )}
        onRetry={() => {}}
        onAbandon={() => {}}
      />,
    );

    // `declared` still offers the abandon, so it carries that line and no refusal one.
    expect(container.querySelectorAll(".meridian-composer-attachment__remedy")).toHaveLength(1);
    expect(settled.container.querySelector(".meridian-composer-attachment__remedy")).toBeNull();
  });
});
