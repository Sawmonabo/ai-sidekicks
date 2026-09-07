// An alert dialog's portal, backdrop, and popup — registered in the window's airspace.
//
// The destructive sibling of `OverlayDialogPopup`, and a separate primitive rather
// than a flag on it because the two are different components in the widget family:
// `AlertDialog.Root` does not dismiss on an outside press, which is the whole reason a
// confirmation uses it, and a shell that took the family as a parameter would be one
// component choosing between two behaviours a caller cannot see from the call site.
//
// The airspace kind is `dialog` and is not a parameter: 12.3 enumerates the kinds by
// what they are on screen, and a confirmation is a dialog.

import { AlertDialog } from "@base-ui/react/alert-dialog";

import { useAirspaceRegistration } from "../airspace-registration.js";

export interface OverlayAlertDialogPopupProps {
  /** Where the popup portals. The frame's overlay root; `undefined` falls back to `<body>`. */
  readonly container?: HTMLElement | null | undefined;
  readonly backdropClassName: string;
  readonly className: string;
  readonly children: React.ReactNode;
}

export function OverlayAlertDialogPopup(props: OverlayAlertDialogPopupProps): React.JSX.Element {
  const airspaceRef = useAirspaceRegistration("dialog");
  return (
    <AlertDialog.Portal container={props.container}>
      <AlertDialog.Backdrop className={props.backdropClassName} />
      <AlertDialog.Popup ref={airspaceRef} className={props.className}>
        {props.children}
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  );
}
