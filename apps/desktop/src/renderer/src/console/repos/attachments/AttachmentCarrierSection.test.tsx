// The seat a file is picked on, and what the ingest trio does with it.
//
// THE CASES DRIVE THE REAL SECTION OVER THE REAL CLIENT, against the scripted port
// every other ingest case in this family drives. That is the claim worth checking:
// until this seat existed the Init / Chunk / Complete flow was reachable from tests
// and from nothing a participant could touch, so a case that drove the client
// directly would have gone on passing over a console with no way to attach anything.

import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SidebarSectionContext } from "../../seats/index.js";
import { SessionStore } from "../../store/index.js";
import { AttachmentCarrierSection } from "./AttachmentCarrierSection.js";
import { ScriptedGrowthPort, patternedBytes } from "./attachment-ingest-scripted-port.js";

/** How long a stream may take to settle before a case gives up on it. */
const INGEST_TIMEOUT_MS = 5_000;

/** The picker's accessible name, which is the label text a person reads. */
const ATTACH_CONTROL = "Attach a file";

/** The name the scripted completion answers with, which replaces the declaration. */
const NORMALIZED_NAME = "notes-1.md";

/** One file small enough to cross in a single chunk, as a picker hands it over. */
function pickedFile(): File {
  return new File([patternedBytes(300)], "notes.md", { type: "text/markdown" });
}

/** The section, open, over a port the case scripts. */
function renderSection(port: ScriptedGrowthPort): HTMLElement {
  const context: SidebarSectionContext = {
    isOpen: true,
    bridge: port.asBridge(),
    sessionStore: new SessionStore({ sessionId: "session-1" }),
    openPane: () => undefined,
  };
  const { container } = render(<AttachmentCarrierSection context={context} />);
  return container;
}

/** Hand the picker a file, exactly as a host file dialog does. */
function pick(container: HTMLElement, file: File): void {
  const picker = within(container).getByLabelText(ATTACH_CONTROL);
  fireEvent.change(picker, { target: { files: [file] } });
}

describe("AttachmentCarrierSection — a picked file reaches the ingest trio", () => {
  it("runs Init, then a chunk carrying the bytes, then Complete", async () => {
    const port = new ScriptedGrowthPort();
    const container = renderSection(port);
    pick(container, pickedFile());
    await waitFor(
      () => {
        expect(container.textContent).toContain(NORMALIZED_NAME);
      },
      { timeout: INGEST_TIMEOUT_MS },
    );
    // The three legs, in the order the protocol requires, each carrying what the
    // registered request shape names. The declaration is the participant's file and
    // the completion's normalized name has replaced it on the card above.
    expect(port.initCalls).toHaveLength(1);
    expect(port.initCalls[0]?.fileName).toBe("notes.md");
    expect(port.initCalls[0]?.declaredSizeBytes).toBe(300);
    expect(port.chunkCalls).toHaveLength(1);
    expect(port.chunkCalls[0]?.sequenceNumber).toBe(0);
    expect(container.textContent).toContain("complete");
  });

  it("negative control: an untouched seat sends nothing and says the carrier is empty", () => {
    // Without this the case above would pass over a section that opened a stream on
    // mount — which would send a request nobody made and mint an artifact from a file
    // nobody chose.
    const port = new ScriptedGrowthPort();
    const container = renderSection(port);
    expect(port.initCalls).toHaveLength(0);
    expect(container.textContent).toContain("No file has been attached in this session.");
  });
});

describe("AttachmentCarrierSection — a refusal renders where the progress would have", () => {
  it("renders a refused open with the daemon's own code", async () => {
    const port = new ScriptedGrowthPort();
    port.refuseBeginWith("artifact.ingest_capacity_exhausted");
    const container = renderSection(port);
    pick(container, pickedFile());
    await waitFor(
      () => {
        expect(container.textContent).toContain("artifact.ingest_capacity_exhausted");
      },
      { timeout: INGEST_TIMEOUT_MS },
    );
    // The stream never opened, so nothing was chunked — and the row says refused
    // rather than sitting at zero bytes with no explanation.
    expect(port.chunkCalls).toHaveLength(0);
    expect(container.textContent).toContain("refused");
  });

  it("negative control: a served open renders no refusal at all", async () => {
    // Without this the case above would pass against a section that printed the
    // refusal region whatever the port answered.
    const port = new ScriptedGrowthPort();
    const container = renderSection(port);
    pick(container, pickedFile());
    await waitFor(
      () => {
        expect(container.textContent).toContain(NORMALIZED_NAME);
      },
      { timeout: INGEST_TIMEOUT_MS },
    );
    expect(container.querySelector(".meridian-attachment__refusal")).toBeNull();
  });
});

describe("AttachmentCarrierSection — the collapsed line", () => {
  it("reports what the carrier holds rather than the section's name", async () => {
    const port = new ScriptedGrowthPort();
    const context: SidebarSectionContext = {
      isOpen: false,
      bridge: port.asBridge(),
      sessionStore: new SessionStore({ sessionId: "session-1" }),
      openPane: () => undefined,
    };
    const { container } = render(<AttachmentCarrierSection context={context} />);
    // Collapsed, so there is no picker to reach — which is the whole difference
    // between the two shapes, and the reason the summary is asserted separately.
    expect(within(container).queryByLabelText(ATTACH_CONTROL)).toBeNull();
    await waitFor(() => {
      expect(container.querySelector(".meridian-attachment-section__summary")).not.toBeNull();
    });
    expect(container.querySelector(".meridian-attachment-section")).toBeNull();
    // The summary is a paragraph, so the absence it carries must take its inline shape:
    // a block-shaped absence puts a `<div>` inside the `<p>`, which the parser closes
    // early and React warns about on every mount.
    const summary = container.querySelector(".meridian-attachment-section__summary");
    expect(summary?.querySelector("div, p, section")).toBeNull();
    expect(summary?.querySelector(".meridian-nothing")?.tagName).toBe("SPAN");
  });
});
