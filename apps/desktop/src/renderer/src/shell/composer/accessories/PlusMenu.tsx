// The `+` menu: everything the composer can add to a send, one click away.
//
// Rule 7's shape — secondary controls live one click away, never as a second
// visible button. The composer keeps exactly one primary action, and attachments
// and workflow start live behind this disclosure rather than beside it.
//
// TWO OCCUPANTS, ONE OF THEM SOMEBODY ELSE'S. The attachment picker is this lane's
// and is built. "Start a workflow" opens a definition picker over the workflow
// definition list and dispatches a workflow run — both registered method strings
// with no shape in the shared contracts package and no growth-port operation, so
// the body is the workflow plan's and this file mounts a seat for it. A picker
// rendered here against no enumeration would be a list of nothing that looks like
// a list of none.
//
// KEYBOARD, NOT MOUSE-ONLY. The disclosure is a real button with `aria-expanded`;
// Escape closes and returns focus to it. An icon-only trigger carries its name in
// the glyph's `title`, which is what makes it announce as anything at all.

import { useCallback, useRef, useState } from "react";
import { Glyph } from "../../../console/primitives/index.js";
import type { OwnerSlotContract } from "../../../console/seats/index.js";
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import { AttachmentPickerSeat } from "./AttachmentPickerSeat.js";
import { WorkflowStartSlot } from "./WorkflowStartSlot.js";

/**
 * The workflow-start seat's three facts. Developer-facing; never rendered.
 *
 * The governance identifier lives in this comment rather than in the value, per the
 * repository's standing rule on runtime strings: the body is the workflow plan's,
 * and the console owes it the menu position and the session it starts within.
 */
export const WORKFLOW_START_SLOT_CONTRACT: OwnerSlotContract = {
  owningTask: "the workflow orchestration plan's definition picker and start dispatch",
  mountObligation:
    "the composer supplies the menu position, the session the run would start in, and the accessible framing of the disclosure; the body owns the definition enumeration, the pinned-version choice, and the start dispatch with its denial rendering",
  deleteShellIn: "the PR that mounts the workflow definition picker into this seat",
};

// The chrome glyph size, and the one number in this file that is a TOKEN IN WAITING.
// `tokens/glyphs.ts` publishes `GLYPH_DEFAULT_SIZE` for a glyph that names no size of
// its own, and the smaller scale composer chrome draws at arrives with the pane-chrome
// substrate as `GLYPH_SIZE_CHROME`. Rebinding to the default here would draw this
// glyph larger than the rail it sits in, and minting the chrome token here would be a
// second declaration of one scale — which is what a token exists to prevent — so the
// literal stands until the token that owns it is in the tree.
const PLUS_GLYPH_SIZE = 14;

export interface PlusMenuProps {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  /** The workflow picker, once its owner mounts one. `undefined` until then. */
  readonly workflowStartBody: React.ReactNode | undefined;
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
        <Glyph name="plus" size={PLUS_GLYPH_SIZE} title="Add to this message" />
      </button>
      {isOpen ? (
        <div className="meridian-plus-menu__panel" aria-label="Add to this message">
          <AttachmentPickerSeat bridge={props.bridge} sessionId={props.sessionId} />
          <WorkflowStartSlot
            contract={WORKFLOW_START_SLOT_CONTRACT}
            body={props.workflowStartBody}
          />
        </div>
      ) : null}
    </div>
  );
}
