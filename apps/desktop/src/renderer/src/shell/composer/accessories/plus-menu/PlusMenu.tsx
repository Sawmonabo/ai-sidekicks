// The `+` menu: everything the composer can add to a send, one click away.
//
// Rule 7's shape — secondary controls live one click away, never as a second
// visible button. The composer keeps exactly one primary action, and attachments
// and workflow start live behind this disclosure rather than beside it.
//
// THREE OCCUPANTS, ONE OF THEM SOMEBODY ELSE'S. The file picker is this menu's own and
// is built; the rows other view families contribute are theirs and are rendered as they
// register them. "Start a workflow" opens a definition picker over the workflow
// definition list and dispatches a workflow run, and that body belongs to the workflows
// family: this file supplies the position, the disclosure and the framing, and takes the
// body as a prop.
//
// IT WAS A RESERVED SEAT AND IS NOT ONE ANY MORE. While no family had the enumeration,
// the entry stood as an owner-slot contract with a "not built yet" absence behind it,
// because a picker rendered against no enumeration would have been a list of nothing
// that looks like a list of none. The workflows family has landed that enumeration and
// the start it dispatches, so the seat's own deletion obligation falls due here: the
// shell, the contract and the reserved state are gone, and the body arrives through
// that family's door.
//
// THE PICKER NO LONGER ASKS BEFORE IT OFFERS. It used to read the effective allow-list
// on the way to opening a file dialog and render that read's refusal instead of the
// dialog — which was right while nothing could carry an upload, and is wrong now that
// the ingest is served: the read refuses on every build the console can run on, so a
// picker gated on it could never open. The allow-list travels as the disclosure beside
// the control, named as the shipped default, which is the arm `Spec-014 §Bounds
// (normative defaults; operator-tunable)` gives a deployment whose effective list
// cannot be read.
//
// KEYBOARD, NOT MOUSE-ONLY. The disclosure is a real button with `aria-expanded`;
// Escape closes and returns focus to it. An icon-only trigger carries its name in
// the glyph's `title`, which is what makes it announce as anything at all.
//
// AND ESCAPE IS NOT THE ONLY WAY OUT. A person who presses `+`, changes their mind,
// and clicks back into the message line has left this menu — and it stayed open over
// the thing they went back to, because Escape was the only path that closed it.
// `outside-dismiss.ts` watches the two ways of leaving; the DISMISSAL is a different
// act from the close and moves no focus, because someone already elsewhere should not
// be pulled back to a trigger they walked away from.
//
// THE PANEL IS NAMED AND THE TRIGGER POINTS AT IT. `aria-label` on a `div` names
// nothing — axe's `aria-prohibited-attr` says so outright — so the panel takes a role
// that can hold a name, and `aria-controls` says which region the disclosure opens.
// The association is spelled only while the panel EXISTS: this menu unmounts its panel
// rather than hiding it, and `aria-controls` pointing at an id in no document is an
// invalid value rather than a helpful hint.

import { useCallback, useId, useRef, useState } from "react";
import { Glyph } from "../../../../console/primitives/index.js";
// The chrome scale, from the one home that publishes it. `GLYPH_DEFAULT_SIZE` would
// draw this mark larger than the rail it sits in; a private copy of the number would
// be the second declaration of one scale that a token exists to prevent.
import { GLYPH_SIZE_CHROME } from "../../../../console/tokens/index.js";
import type { ConsoleBridge } from "../../../../console/bridge/index.js";
import type { ComposerArtifactAttachment } from "../../../../console/seats/index.js";
import { ComposerAttachmentPicker } from "../attachments/ComposerAttachmentPicker.js";
import { FamilyAttachMenu } from "../attachments/FamilyAttachMenu.js";
import { useOutsideDismiss } from "./outside-dismiss.js";

export interface PlusMenuProps {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  /** The deck pane in focus, as a handle. Handed to the rows that need one. */
  readonly focusedPaneId: string | undefined;
  /** Files a person chose, on their way to the session's attachment carrier. */
  readonly onFilesChosen: (files: readonly File[]) => void;
  /** An artifact a view family put on the message, on its way to the strip. */
  readonly onFamilyAttached: (attachment: ComposerArtifactAttachment) => void;
  /**
   * The workflow picker, composed by the family that owns the enumeration it lists.
   *
   * Required and never optional: the entry is part of this menu, and a caller that
   * omitted it would leave the disclosure holding one item with nothing saying why.
   */
  readonly workflowStartBody: React.ReactNode;
}

export function PlusMenu(props: PlusMenuProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  /** Leaving, which is not the same act as closing: it moves no focus. */
  const dismiss = useCallback(() => {
    setIsOpen(false);
  }, []);

  useOutsideDismiss(regionRef, isOpen, dismiss);

  return (
    <div
      className="meridian-plus-menu"
      ref={regionRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && isOpen) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        className="meridian-plus-menu__trigger"
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        onClick={() => {
          setIsOpen((wasOpen) => !wasOpen);
        }}
      >
        <Glyph name="plus" size={GLYPH_SIZE_CHROME} title="Add to this message" />
      </button>
      {isOpen ? (
        <div
          className="meridian-plus-menu__panel"
          id={panelId}
          role="group"
          aria-label="Add to this message"
        >
          <ComposerAttachmentPicker
            onFilesChosen={(files) => {
              props.onFilesChosen(files);
              // Closed on a choice, because the choice IS the act: what happens next
              // is on the strip above the message, and a menu left open would cover it.
              close();
            }}
          />
          <FamilyAttachMenu
            bridge={props.bridge}
            sessionId={props.sessionId}
            focusedPaneId={props.focusedPaneId}
            onAttached={(attachment) => {
              props.onFamilyAttached(attachment);
              // Closed for the picker's reason, which is the same reason: the attach IS
              // the act, and what happens next is on the strip above the message. A
              // REFUSAL does not come through here and the menu stays open for it —
              // the row renders that answer where the person pressed it.
              close();
            }}
          />
          {/* The menu's own placement around a body it did not author, which is the
              whole of this file's half of the entry. */}
          <div className="meridian-plus-menu__workflow">{props.workflowStartBody}</div>
        </div>
      ) : null}
    </div>
  );
}
