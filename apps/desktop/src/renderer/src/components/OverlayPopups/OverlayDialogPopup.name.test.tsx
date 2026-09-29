// How a dialog routed through this primitive gets its accessible name, both ways.
//
// WHY THE LABEL IS OPTIONAL AND NOT LAX. Four repos dialogs head their popup with a
// `Dialog.Title`, and Base UI hands the popup that title's id as `aria-labelledby` —
// so a `label` passed beside one is a second spelling of a name no accessible-name
// computation ever reads. The third case below is what makes that a measurement
// rather than an assertion about the spec: with both present the TITLE wins, so the
// label is inert, and an inert prop a reader has to compare against the title beside
// it is the drift this primitive declines to invite.
//
// AND THE SECOND CASE IS WHY THE PROP SURVIVES AT ALL. The command palette and the
// attach form head their popups with ordinary elements, so `aria-label` is the only
// name they have — a rule that dropped the prop would leave both unnamed.
//
// THE NAME IS ASKED FOR THROUGH THE ROLE QUERY, which computes it the way a reader's
// software does, rather than by reading the attribute and calling that the name. The
// attribute is asserted too, and separately: in the third case it is present and the
// name is something else, which is the whole finding.

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
    // And nothing was invented on its behalf: an omitted label reaches the element as
    // no attribute, rather than as an empty one standing in for a name.
    expect(popup.hasAttribute("aria-label")).toBe(false);
  });

  it("takes the label where the surface heads its popup with an ordinary element", () => {
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
    // Without this the rule above would be a preference. `aria-labelledby` wins the
    // accessible-name computation, so the label is carried on the element and read by
    // nothing — which is exactly why the surfaces that mount a title pass none.
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
