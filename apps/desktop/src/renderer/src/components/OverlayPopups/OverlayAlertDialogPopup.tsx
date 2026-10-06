// An alert dialog's portal, backdrop and popup, registered in the window's airspace. Separate from
// `OverlayDialogPopup` because `AlertDialog.Root` does not dismiss on an outside press.

import { AlertDialog } from "@base-ui/react/alert-dialog";

import { useModalOverlayAirspace } from "#renderer/hooks/useModalOverlayAirspace.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { overlayClassName } from "./overlay-class-name.js";

/** Props for `OverlayAlertDialogPopup`. */
export interface OverlayAlertDialogPopupProps {
  /** Where the popup portals. The frame's overlay root; `undefined` is its own window's body. */
  readonly container?: HTMLElement | null | undefined;
  readonly backdropClassName: string;
  readonly className: string;
  readonly children: React.ReactNode;
}

/** Portal, backdrop and popup for a confirmation; the caller owns `AlertDialog.Root`. */
export function OverlayAlertDialogPopup(props: OverlayAlertDialogPopupProps): React.JSX.Element {
  const ownerWindow = useOwnerWindow();
  const airspace = useModalOverlayAirspace();
  return (
    <AlertDialog.Portal container={props.container ?? ownerWindow.document.body}>
      <AlertDialog.Backdrop
        ref={airspace.backdropRef}
        className={overlayClassName(props.backdropClassName)}
      />
      <AlertDialog.Popup ref={airspace.popupRef} className={overlayClassName(props.className)}>
        {props.children}
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  );
}
