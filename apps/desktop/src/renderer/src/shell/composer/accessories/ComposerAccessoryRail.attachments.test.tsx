// The rail's attachment zone: the strip, the `+` menu's file picker, and the rows other
// view families put in that menu.
//
// Mounted through the shared rail harness rather than against the components directly,
// because the claims here are about composition — that a drop reaches the carrier the
// rail opened, that a family's answer lands on the strip the rail renders, and that a
// menu with nothing registered shows nothing at all.

import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearComposerAttachMenu,
  registerComposerAttachMenuEntry,
  type ComposerAttachOutcome,
} from "../../../console/seats/index.js";
import { eventCarrying, fileTransferOf } from "./attachments/attachment-input.test-support.js";
import { mountRail, railRegion } from "./rail.test-support.js";

/** A row that always settles the same way, so a case varies only the outcome. */
function registerRow(id: string, outcome: ComposerAttachOutcome): void {
  registerComposerAttachMenuEntry({
    id,
    owner: "test-family",
    label: "Attach page",
    glyph: "browser",
    detail: "Attach what the focused pane is showing.",
    attach: () => Promise.resolve(outcome),
  });
}

/** Open the `+` menu, which is where both of its occupants live. */
function openPlusMenu(container: HTMLElement): void {
  const trigger = container.querySelector(".meridian-plus-menu__trigger");
  if (trigger === null) {
    throw new Error("the rail rendered no plus-menu trigger");
  }
  fireEvent.click(trigger);
}

afterEach(() => {
  // The registry is process-wide, so a row left behind would appear in the next file's
  // composer as a menu entry nobody registered.
  clearComposerAttachMenu();
});

describe("the composer's attachment strip", () => {
  it("is absent while the message carries nothing", () => {
    const container = mountRail([]);
    expect(container.querySelector(".meridian-composer-attachments")).toBeNull();
  });

  it("puts a dropped file on the strip under the name it was declared with", async () => {
    const container = mountRail([]);
    const region = railRegion(container);
    const dropped = new File(["payload"], "notes.md", { type: "text/plain" });
    const event = eventCarrying("drop", "dataTransfer", fileTransferOf([dropped]));
    await act(async () => {
      region.dispatchEvent(event);
    });
    const strip = container.querySelector(".meridian-composer-attachments");
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain("notes.md");
    // The running count against the bound, which is a figure and never a gate.
    expect(strip?.textContent).toContain("of 10 attached");
  });

  it("carries its name on an element that can hold one", async () => {
    // The strip was a `div` with an `aria-label`, and a `div` is `generic`: naming a
    // generic element names nothing, so the label reached no assistive technology at
    // all. A landmark takes it — and the strip is one, a standing region beside the
    // message line rather than decoration inside it. (The accessibility tier cannot
    // stand in for this case: `aria-prohibited-attr` is outside the WCAG A/AA tag set
    // that tier runs, measured 2026-09-09 against a planted `div aria-label`.)
    const container = mountRail([]);
    const region = railRegion(container);
    const event = eventCarrying(
      "drop",
      "dataTransfer",
      fileTransferOf([new File(["payload"], "notes.md", { type: "text/plain" })]),
    );
    await act(async () => {
      region.dispatchEvent(event);
    });
    const strip = container.querySelector(".meridian-composer-attachments");

    expect(strip?.tagName).toBe("SECTION");
    expect(strip?.getAttribute("aria-label")).toBe("Attachments on this message");
  });
});

describe("the `+` menu's family rows", () => {
  it("renders nothing where no family has registered one", () => {
    // The negative control for every case below: without it, a menu that rendered a
    // hard-coded row would satisfy them all.
    const container = mountRail([]);
    openPlusMenu(container);
    expect(container.querySelector(".meridian-attach-menu")).toBeNull();
  });

  it("renders a registered row with the owner's own label and detail", () => {
    registerRow("test.attach", {
      status: "attached",
      attachment: { artifactId: "artifact-9", mediaType: "image/png", byteLength: 2048 },
    });
    const container = mountRail([]);
    openPlusMenu(container);
    expect(screen.getByText("Attach page")).toBeTruthy();
    expect(screen.getByText("Attach what the focused pane is showing.")).toBeTruthy();
  });

  it("puts what a row attached onto the strip, as the artifact the pipeline minted", async () => {
    registerRow("test.attach", {
      status: "attached",
      attachment: { artifactId: "artifact-9", mediaType: "image/png", byteLength: 2048 },
    });
    const container = mountRail([]);
    openPlusMenu(container);
    await act(async () => {
      fireEvent.click(screen.getByText("Attach page"));
    });
    const strip = container.querySelector(".meridian-composer-attachments");
    expect(strip?.textContent).toContain("artifact-9");
    expect(strip?.textContent).toContain("image/png");
    // Composed and stated as held, because no registered send carrier takes a typed
    // attachment list.
    expect(strip?.textContent).toContain("1 ready to reference");
  });

  it("renders a row's refusal in the composer, where the person pressed the row", async () => {
    registerRow("test.attach", {
      status: "refused",
      refusal: {
        origin: "test-family",
        code: "no-focused-pane",
        detail: "There is no focused pane to attach a page from.",
      },
    });
    const container = mountRail([]);
    openPlusMenu(container);
    await act(async () => {
      fireEvent.click(screen.getByText("Attach page"));
    });
    expect(screen.getByText(/no focused pane/)).toBeTruthy();
    expect(container.querySelector(".meridian-composer-attachments")).toBeNull();
  });
});

describe("the `+` menu closes when a person is done with it", () => {
  /** Whether the panel is on screen, which is what "open" means for this menu. */
  function isPanelOpen(container: HTMLElement): boolean {
    return container.querySelector(".meridian-plus-menu__panel") !== null;
  }

  it("closes once a family row has actually attached something", async () => {
    // The picker closed on a choice and this row did not, so the menu stayed open
    // over the strip that was reporting what it had just attached. The attach IS the
    // act; what happens next is above the message.
    registerRow("test.attach", {
      status: "attached",
      attachment: { artifactId: "artifact-9", mediaType: "image/png", byteLength: 2048 },
    });
    const container = mountRail([]);
    openPlusMenu(container);
    expect(isPanelOpen(container)).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText("Attach page"));
    });

    expect(isPanelOpen(container)).toBe(false);
  });

  it("negative control: a row that refused leaves the menu open on its answer", async () => {
    // The refusal renders inside the menu, so closing on one would take the answer
    // off screen in the same act that produced it.
    registerRow("test.attach", {
      status: "refused",
      refusal: {
        origin: "test-family",
        code: "no-focused-pane",
        detail: "There is no focused pane to attach a page from.",
      },
    });
    const container = mountRail([]);
    openPlusMenu(container);

    await act(async () => {
      fireEvent.click(screen.getByText("Attach page"));
    });

    expect(isPanelOpen(container)).toBe(true);
    expect(screen.getByText(/no focused pane/)).toBeTruthy();
  });

  it("dismisses on a pointer press outside it", () => {
    // Escape was the only way out, so a person who pressed `+`, changed their mind,
    // and clicked back into the message line left the panel open over what they had
    // gone back to. `pointerdown` and not `click`: a press that starts outside and
    // releases inside fires no document click at all.
    const container = mountRail([]);
    openPlusMenu(container);
    expect(isPanelOpen(container)).toBe(true);

    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

    expect(isPanelOpen(container)).toBe(false);
  });

  it("dismisses when focus leaves the panel", () => {
    const container = mountRail([]);
    openPlusMenu(container);

    act(() => {
      document.body.dispatchEvent(new Event("focusin", { bubbles: true }));
    });

    expect(isPanelOpen(container)).toBe(false);
  });

  it("negative control: a press inside the panel leaves it open", () => {
    // Without this the two cases above would pass over a menu that closed on any
    // press anywhere, which would shut itself the moment a person reached for the
    // picker inside it.
    const container = mountRail([]);
    openPlusMenu(container);
    const panel = container.querySelector(".meridian-plus-menu__panel");
    expect(panel).not.toBeNull();

    act(() => {
      panel?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      panel?.dispatchEvent(new Event("focusin", { bubbles: true }));
    });

    expect(isPanelOpen(container)).toBe(true);
  });

  it("names the panel it opens, and points at it only while it exists", () => {
    // `aria-label` on a `div` names nothing — axe's `aria-prohibited-attr` — and an
    // `aria-controls` naming an id in no document is an invalid value rather than a
    // helpful hint, which is why the association is spelled only while open.
    const container = mountRail([]);
    const trigger = container.querySelector(".meridian-plus-menu__trigger");
    expect(trigger?.getAttribute("aria-controls")).toBeNull();

    openPlusMenu(container);
    const panel = container.querySelector(".meridian-plus-menu__panel");

    expect(panel?.getAttribute("role")).toBe("group");
    expect(trigger?.getAttribute("aria-controls")).toBe(panel?.getAttribute("id"));
    expect(panel?.getAttribute("id")).not.toBeNull();
  });
});
