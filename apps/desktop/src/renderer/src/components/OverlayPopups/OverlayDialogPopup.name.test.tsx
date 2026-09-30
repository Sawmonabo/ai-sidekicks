// How a dialog gets its accessible name: from its `Dialog.Title`, or from `label` when the caller
// heads it with an ordinary element. A `label` beside a title is inert because `aria-labelledby`
// wins, so the name is asked for through the role query, not read off the attribute.

import { render, screen } from "@testing-library/react";
import { Dialog } from "@base-ui/react/dialog";
import { describe, expect, it } from "vitest";

import { OverlayDialogPopup } from "./OverlayDialogPopup.js";

describe("OverlayDialogPopup — the accessible name, however the caller supplies it", () => {
  it("takes the caller's own title, with no label passed", () => {
    render(
      <Dialog.Root open modal="trap-focus">
        <OverlayDialogPopup backdropClassName="backdrop" className="popup">
          <Dialog.Title>Attach a repository</Dialog.Title>
          body
        </OverlayDialogPopup>
      </Dialog.Root>,
    );
    const popup = screen.getByRole("dialog", { name: "Attach a repository" });
    // An omitted label reaches the element as no attribute, not an empty one.
    expect(popup.hasAttribute("aria-label")).toBe(false);
  });

  it("takes the label where the caller heads its popup with an ordinary element", () => {
    render(
      <Dialog.Root open modal="trap-focus">
        <OverlayDialogPopup backdropClassName="backdrop" className="popup" label="Command palette">
          <h3>Command palette</h3>
        </OverlayDialogPopup>
      </Dialog.Root>,
    );
    const popup = screen.getByRole("dialog", { name: "Command palette" });
    expect(popup.getAttribute("aria-label")).toBe("Command palette");
  });

  it("negative control: a label beside a title is inert, and the title is the name", () => {
    // Negative control: `aria-labelledby` wins, so the label is carried and read by nothing.
    render(
      <Dialog.Root open modal="trap-focus">
        <OverlayDialogPopup
          backdropClassName="backdrop"
          className="popup"
          label="A name nothing reads"
        >
          <Dialog.Title>Bind a workspace</Dialog.Title>
        </OverlayDialogPopup>
      </Dialog.Root>,
    );
    const popup = screen.getByRole("dialog", { name: "Bind a workspace" });
    expect(popup.getAttribute("aria-label")).toBe("A name nothing reads");
    expect(screen.queryByRole("dialog", { name: "A name nothing reads" })).toBeNull();
  });
});
