// A modal dialog's portal, backdrop and popup, registered in the window's airspace once here
// rather than per overlay, so a consumer cannot mount one without registering it.
//
// The caller keeps `Dialog.Root` (open state, modality, trigger).
//
// A `Dialog.Title` already names the popup (Base UI sets `aria-labelledby`, which wins over
// `aria-label`), so `label` is only for a caller that heads its popup with an ordinary element.

import { Dialog } from "@base-ui/react/dialog";

import { useModalOverlayAirspace } from "@renderer/hooks/useModalOverlayAirspace.js";
import { useOwnerWindow } from "@renderer/hooks/owner-window/useOwnerWindow.js";

/** Props for `OverlayDialogPopup`. */
export interface OverlayDialogPopupProps {
  /** Where the popup portals. The frame's overlay root; `undefined` is its own window's body. */
  readonly container?: HTMLElement | null | undefined;
  readonly backdropClassName: string;
  readonly className: string;
  /** The popup's accessible name, for a caller that mounts no `Dialog.Title` of its own. */
  readonly label?: string | undefined;
  /** What takes focus when the dialog opens, where the caller owns a better answer. */
  readonly initialFocus?: React.RefObject<HTMLElement | null> | undefined;
  readonly children: React.ReactNode;
}

/**
 * Portal, backdrop and popup for a modal dialog; registers the popup and backdrop in the airspace.
 */
export function OverlayDialogPopup(props: OverlayDialogPopupProps): React.JSX.Element {
  const ownerWindow = useOwnerWindow();
  const airspace = useModalOverlayAirspace();
  return (
    <Dialog.Portal container={props.container ?? ownerWindow.document.body}>
      <Dialog.Backdrop ref={airspace.backdropRef} className={props.backdropClassName} />
      <Dialog.Popup
        ref={airspace.popupRef}
        className={props.className}
        aria-label={props.label}
        initialFocus={props.initialFocus}
      >
        {props.children}
      </Dialog.Popup>
    </Dialog.Portal>
  );
}
