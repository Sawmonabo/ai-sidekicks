// Drop and paste over the composer region, held to the one guard that matters most:
// a paste carrying no file is left entirely alone, because the message input lives
// inside this same region and pasting text into it is the commonest act there is.

import { useRef } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { eventCarrying, fileListOf, fileTransferOf } from "./attachment-input.test-support.js";
import { useAttachmentDropTarget } from "./use-attachment-drop.js";

/** One file, as a picker or a drop would hand it over. */
function fileNamed(name: string): File {
  return new File(["payload"], name, { type: "text/plain" });
}

/** Dispatch one carrying event and hand it back, so a case can read what it settled. */
function dispatch(target: HTMLElement, type: string, property: string, value: unknown): Event {
  const event = eventCarrying(type, property, value);
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** The region the binding is bound over, with what it reports rendered onto it. */
function DropProbe(props: {
  readonly onFilesChosen: (files: readonly File[]) => void;
}): React.JSX.Element {
  const regionRef = useRef<HTMLElement | null>(null);
  const isDraggingFiles = useAttachmentDropTarget({
    region: regionRef,
    onFilesChosen: props.onFilesChosen,
  });
  return <section ref={regionRef} data-dragging={String(isDraggingFiles)} />;
}

function mountProbe(): { readonly region: HTMLElement; readonly delivered: File[][] } {
  const delivered: File[][] = [];
  const { container } = render(
    <DropProbe
      onFilesChosen={(files) => {
        delivered.push([...files]);
      }}
    />,
  );
  const region = container.querySelector("section");
  if (region === null) {
    throw new Error("the probe rendered no region");
  }
  return { region, delivered };
}

describe("the composer's drop and paste binding", () => {
  it("takes a dropped file and stops the window navigating to it", () => {
    const { region, delivered } = mountProbe();
    const event = dispatch(region, "drop", "dataTransfer", fileTransferOf([fileNamed("notes.md")]));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.[0]?.name).toBe("notes.md");
    expect(event.defaultPrevented).toBe(true);
  });

  it("takes a pasted file and consumes the paste", () => {
    const { region, delivered } = mountProbe();
    const event = dispatch(region, "paste", "clipboardData", {
      files: fileListOf([fileNamed("capture.png")]),
    });
    expect(delivered).toHaveLength(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("negative control: a paste carrying no file is not touched at all", () => {
    // Without this, a binding that called `preventDefault()` on every paste would pass
    // the case above and silently break pasting text into the message line.
    const { region, delivered } = mountProbe();
    const event = dispatch(region, "paste", "clipboardData", { files: fileListOf([]) });
    expect(delivered).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("stays lit while a drag crosses an inner boundary, and clears when it leaves", () => {
    const { region } = mountProbe();
    const transfer = fileTransferOf([fileNamed("notes.md")]);
    dispatch(region, "dragenter", "dataTransfer", transfer);
    expect(region.getAttribute("data-dragging")).toBe("true");
    // Entering a child fires `dragenter` again before the parent's `dragleave`, which
    // is exactly the pair a flag would get wrong.
    dispatch(region, "dragenter", "dataTransfer", transfer);
    dispatch(region, "dragleave", "dataTransfer", transfer);
    expect(region.getAttribute("data-dragging")).toBe("true");
    dispatch(region, "dragleave", "dataTransfer", transfer);
    expect(region.getAttribute("data-dragging")).toBe("false");
  });

  it("ignores a drag that declares no files, so a text drag reaches the input", () => {
    const { region, delivered } = mountProbe();
    const textDrag = { types: ["text/plain"], files: fileListOf([]) } as unknown as DataTransfer;
    const event = dispatch(region, "drop", "dataTransfer", textDrag);
    expect(region.getAttribute("data-dragging")).toBe("false");
    expect(delivered).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });
});
