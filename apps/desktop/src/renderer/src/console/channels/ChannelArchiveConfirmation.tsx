import { AlertDialog } from "@base-ui/react/alert-dialog";

import { OverlayAlertDialogPopup } from "../primitives/index.js";

/**
 * Archiving, and what it costs, stated before it happens.
 *
 * An alert dialog rather than a button that fires on press, on the membership
 * ledger's precedent and for its reason: archival is the one lifecycle move the
 * opposite control does not undo. A muted channel unmutes; an archived one is
 * terminal, sinks below the live rows, and offers nothing afterwards — so it is
 * confirmed once, with the consequence in the sentence a person is agreeing to.
 *
 * ONCE, AND NOT TWICE. The confirmation is the whole of the ceremony: a second
 * are-you-sure would train a person to press through both.
 */
export function ChannelArchiveConfirmation(props: {
  readonly channelLabel: string;
  /** Some row's move is in flight, so this row's confirmation cannot be opened. */
  readonly isAnyPending: boolean;
  readonly isArchiving: boolean;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        className="meridian-channel-row__act"
        disabled={props.isAnyPending}
        aria-label={`Archive ${props.channelLabel}`}
      >
        {props.isArchiving ? "Archiving…" : "Archive"}
      </AlertDialog.Trigger>
      {/* The popup shell is the primitive's, which is what puts this confirmation in
          the window's airspace: a native browser-pane view yields to whatever is
          registered there, and a confirmation painted over by one is forbidden
          outright. */}
      <OverlayAlertDialogPopup
        backdropClassName="meridian-channels__dialog-backdrop"
        className="meridian-channels__dialog"
      >
        <AlertDialog.Title className="meridian-channels__dialog-title">
          Archive this channel?
        </AlertDialog.Title>
        <AlertDialog.Description className="meridian-channels__dialog-body">
          Archiving is terminal. The channel moves below the live ones and stops taking runs, and
          nothing here brings it back — a channel whose rhythm turned out wrong is replaced, not
          reconfigured.
        </AlertDialog.Description>
        <div className="meridian-channels__dialog-acts">
          <AlertDialog.Close className="meridian-channels__dialog-cancel">
            Keep it
          </AlertDialog.Close>
          <AlertDialog.Close
            className="meridian-channels__dialog-confirm"
            onClick={props.onConfirm}
          >
            Archive
          </AlertDialog.Close>
        </div>
      </OverlayAlertDialogPopup>
    </AlertDialog.Root>
  );
}
