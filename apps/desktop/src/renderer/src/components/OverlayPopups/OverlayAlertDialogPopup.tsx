// An alert dialog's portal, backdrop and popup, registered in the window's airspace. Separate from
// `OverlayDialogPopup` because `AlertDialog.Root` does not dismiss on an outside press. The
// airspace kind is fixed at `dialog`.

import { AlertDialog } from "@base-ui/react/alert-dialog";

import { useModalOverlayAirspace } from "@renderer/hooks/useModalOverlayAirspace.js";

/** Props for `OverlayAlertDialogPopup`. */
export interface OverlayAlertDialogPopupProps {
  /** Where the popup portals. The frame's overlay root; `undefined` falls back to `<body>`. */
  readonly container?: HTMLElement | null | undefined;
  readonly backdropClassName: string;
  readonly className: string;
  readonly children: React.ReactNode;
}

/** Portal, backdrop and popup for a confirmation; the caller owns `AlertDialog.Root`. */
export function OverlayAlertDialogPopup(props: OverlayAlertDialogPopupProps): React.JSX.Element {
  const airspace = useModalOverlayAirspace("dialog");
  return (
    <AlertDialog.Portal container={props.container}>
      <AlertDialog.Backdrop ref={airspace.backdropRef} className={props.backdropClassName} />
      <AlertDialog.Popup ref={airspace.popupRef} className={props.className}>
        {props.children}
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  );
}
