// The `+` menu: everything the composer can add to a send, one click away.
//
// Rule 7's shape — secondary controls live one click away, never as a second
// visible button. The composer keeps exactly one primary action, and attachments
// and workflow start live behind this disclosure rather than beside it.
//
// TWO OCCUPANTS, ONE OF THEM SOMEBODY ELSE'S. The attachment picker is this menu's
// own and is built. "Start a workflow" opens a definition picker over the workflow
// definition list and dispatches a workflow run, and that body belongs to the
// workflows family: this file supplies the position, the disclosure and the framing,
// and takes the body as a prop.
//
// IT WAS A RESERVED SEAT AND IS NOT ONE ANY MORE. While no family had the enumeration,
// the entry stood as an owner-slot contract with a "not built yet" absence behind it,
// because a picker rendered against no enumeration would have been a list of nothing
// that looks like a list of none. The workflows family has landed that enumeration and
// the start it dispatches, so the seat's own deletion obligation falls due here: the
// shell, the contract and the reserved state are gone, and the body arrives through
// that family's door.
//
// KEYBOARD, NOT MOUSE-ONLY. The disclosure is a real button with `aria-expanded`;
// Escape closes and returns focus to it. An icon-only trigger carries its name in
// the glyph's `title`, which is what makes it announce as anything at all.

import { useCallback, useRef, useState } from "react";
import { Glyph } from "../../../../console/primitives/index.js";
// The chrome scale, from the one home that publishes it. `GLYPH_DEFAULT_SIZE` would
// draw this mark larger than the rail it sits in; a private copy of the number would
// be the second declaration of one scale that a token exists to prevent.
import { GLYPH_SIZE_CHROME } from "../../../../console/tokens/index.js";
import type { ConsoleBridge } from "../../../../console/bridge/index.js";
import { AttachmentPickerSeat } from "./AttachmentPickerSeat.js";

export interface PlusMenuProps {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
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

  const close = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  return (
    <div
      className="meridian-plus-menu"
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
        onClick={() => {
          setIsOpen((wasOpen) => !wasOpen);
        }}
      >
        <Glyph name="plus" size={GLYPH_SIZE_CHROME} title="Add to this message" />
      </button>
      {isOpen ? (
        <div className="meridian-plus-menu__panel" aria-label="Add to this message">
          <AttachmentPickerSeat bridge={props.bridge} sessionId={props.sessionId} />
          {/* The menu's own placement around a body it did not author, which is the
              whole of this file's half of the entry. */}
          <div className="meridian-plus-menu__workflow">{props.workflowStartBody}</div>
        </div>
      ) : null}
    </div>
  );
}
