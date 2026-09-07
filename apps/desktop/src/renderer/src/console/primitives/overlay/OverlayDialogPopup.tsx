// A modal dialog's portal, backdrop, and popup — registered in the window's airspace.
//
// `Spec-023 §Console Design (Meridian)` 12.3 puts the registration "once, at the
// primitive layer, never per overlay instance", and its Never bullet forbids a
// consumer registering an overlay by hand at a call site. Both are only enforceable
// if a consumer cannot MOUNT one by hand either: an attach form that rendered its own
// `Dialog.Portal` never went near the registration, so there was nothing at that site
// to forget and the rule had nothing to bite on. So the popup shell is the primitive
// and the body is the caller's.
//
// WHAT STAYS WITH THE CALLER. `Dialog.Root` — the open state, the modality, and the
// trigger — is state and not airspace, and a surface that wraps its dialog in a
// combobox root (the palette does) composes those roots itself. What crosses into
// here is the part of the tree that leaves the layout.
//
// THE KIND IS THE CALLER'S TO NAME. 12.3 enumerates seven overlay kinds and a dialog
// is one of them, but the command palette is its own — the same three parts, a
// different thing on screen — so the kind is a parameter defaulted to the common
// answer rather than fixed here.

import { Dialog } from "@base-ui/react/dialog";

import { useModalOverlayAirspace } from "./modal-airspace.js";
import type { AirspaceOverlayKind } from "../../core/index.js";

export interface OverlayDialogPopupProps {
  /** Which of 12.3's overlay kinds this is. `dialog` unless the surface is its own. */
  readonly airspaceKind?: AirspaceOverlayKind;
  /** Where the popup portals. The frame's overlay root; `undefined` falls back to `<body>`. */
  readonly container?: HTMLElement | null | undefined;
  readonly backdropClassName: string;
  readonly className: string;
  /** The popup's accessible name. A dialog without one is an unnamed region. */
  readonly label: string;
  /** What takes focus when the dialog opens, where the caller owns a better answer. */
  readonly initialFocus?: React.RefObject<HTMLElement | null> | undefined;
  readonly children: React.ReactNode;
}

export function OverlayDialogPopup(props: OverlayDialogPopupProps): React.JSX.Element {
  const airspace = useModalOverlayAirspace(props.airspaceKind ?? "dialog");
  return (
    <Dialog.Portal container={props.container}>
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
