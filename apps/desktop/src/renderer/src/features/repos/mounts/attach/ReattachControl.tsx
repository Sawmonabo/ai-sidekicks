// Re-attaching one mount's path, from the card that says the mount has drifted.
//
// THE REMEDY FOR THE THIRD HEALTH VERDICT, AND ONLY FOR IT. `identity_mismatch` is a
// permanent refusal — the root is
// reachable and is no longer the repository this mount was attached as, so every bind
// and every run on this mount refuses until someone acts — and names re-attaching as
// the recovery. A card that reported the verdict and offered nothing would name a
// permanent state and no way out of it.
//
// IT IS NOT OFFERED FOR `unreachable`, and the restraint is the point. An unreachable
// root is a transient condition — a disconnected volume, a machine asleep — whose
// remedy is to make the path reachable again, and a re-attach control there would
// invite a second mount row for a repository that is about to answer for itself.
//
// AN ALERT DIALOG, BECAUSE THE COST IS REAL AND IS NOT OBVIOUS. Re-attach does not
// repair this mount: it mints a NEW mount, and this row stays as history alongside it.
// A person who expected a repair and got a second row would have consented to
// something they were not told about, so the confirmation says it in the words the
// daemon's own model uses. The alert variant traps focus and does not dismiss on an
// outside press, which is what separates a consequence from data entry.
//
// IT REUSES THE ATTACH CONTROLLER RATHER THAN MINTING A SECOND CALLER. One console,
// one attach caller: the path comes off the mount row, so there is no form and nothing
// to validate, and the settlement renders in the same arms the dialog's does.
//
// AND IT REUSES THE CONFIRMATION LIFECYCLE FOR THE SAME REASON. The confirm control
// closing this dialog is what reaches `onOpenChange`, so a discard keyed on the close
// takes back the `sending` that press had just published;
// `hooks/useConfirmationLifecycle.ts` holds the two moments a discard belongs to,
// and both of the repo mounts' alert dialogs wire it rather than each stating the rule.

import "./attach.css";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useCallback, useEffect, useRef } from "react";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import {
  Nothing,
  OverlayAlertDialogPopup,
  WireFigure,
} from "@renderer/console/primitives/index.js";
import type { RepoOperations } from "../../repo-operations.js";
import { useConfirmationLifecycle } from "../hooks/useConfirmationLifecycle.js";
import { type AttachRequestReading } from "./attach-controller.js";
import { useAttachController } from "./hooks/useAttachController.js";

export interface ReattachControlProps {
  readonly bridge: PlatformBridge;
  /** The attach the confirmation sends. */
  readonly operations: Pick<RepoOperations, "attachRepository">;
  /** The session whose section this card is drawn in. */
  readonly sessionId: string;
  /** The path this mount was attached at. Re-sent verbatim; nothing is re-derived. */
  readonly localPath: string;
  /** Ask the section to read again once the re-attach has minted a mount. */
  readonly onAttached: () => void;
}

export function ReattachControl(props: ReattachControlProps): React.JSX.Element {
  const { reading, attach, clearAct } = useAttachController(
    props.bridge,
    props.sessionId,
    props.operations,
  );
  const { localPath, onAttached } = props;

  const confirm = useCallback(() => {
    attach(localPath);
  }, [attach, localPath]);
  // The settlement belongs to the press that produced it. A dialog reopened asks the
  // question again, a dialog canceled discards the answer with it, and the confirm
  // press — which closes this dialog — discards nothing.
  const lifecycle = useConfirmationLifecycle(clearAct);

  // ONE READ PER MINTED MOUNT, on the dialog's own reasoning: the id is what changes
  // when an attach settles, and a ref is what keeps a re-render from asking again.
  const announcedMountId = useRef<string | undefined>(undefined);
  const mintedMountId = reading.status === "attached" ? reading.response.repoMountId : undefined;
  useEffect(() => {
    if (mintedMountId === undefined || announcedMountId.current === mintedMountId) {
      return;
    }
    announcedMountId.current = mintedMountId;
    onAttached();
  }, [mintedMountId, onAttached]);

  return (
    <div className="meridian-reattach">
      <AlertDialog.Root onOpenChange={lifecycle.openChanged}>
        <AlertDialog.Trigger
          className="meridian-reattach__trigger"
          disabled={reading.status === "sending"}
          aria-label={`Re-attach ${localPath}`}
        >
          Re-attach this path
        </AlertDialog.Trigger>
        {/* The portal, backdrop and popup are the primitive's, which is what puts this
            confirmation in the window's airspace: a native browser-pane view yields to
            what is registered there, and a confirmation it painted over is the one
            thing forbidden outright. */}
        <OverlayAlertDialogPopup
          backdropClassName="meridian-reattach__backdrop"
          className="meridian-reattach__dialog"
        >
          <AlertDialog.Title className="meridian-reattach__title">
            Re-attach this path as a new mount?
          </AlertDialog.Title>
          <AlertDialog.Description className="meridian-reattach__body">
            This mount is not repaired. The path is resolved again and attached as a new mount; this
            row stays as history, and nothing bound to it is moved across.
          </AlertDialog.Description>
          <dl className="meridian-reattach__subject">
            <dt>Path</dt>
            <dd>
              <WireFigure value={localPath} title={localPath} />
            </dd>
          </dl>
          <div className="meridian-reattach__acts">
            <AlertDialog.Close className="meridian-reattach__cancel" onClick={lifecycle.canceled}>
              Leave it as it is
            </AlertDialog.Close>
            <AlertDialog.Close className="meridian-reattach__confirm" onClick={confirm}>
              Re-attach
            </AlertDialog.Close>
          </div>
        </OverlayAlertDialogPopup>
      </AlertDialog.Root>
      {renderSettlement(reading)}
    </div>
  );
}

/**
 * What the re-attach did, rendered on the card rather than inside the dialog.
 *
 * Outside the popup deliberately. The confirmation closes on the press, since that is what
 * `AlertDialog.Close` on the confirm control means, so a settlement rendered inside it would
 * be drawn into a popup that is already gone. On the card it sits beside the verdict it is
 * about.
 */
function renderSettlement(act: AttachRequestReading): React.JSX.Element | null {
  switch (act.status) {
    case "idle":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Re-attaching." />;
    case "attached":
      return (
        <p className="meridian-reattach__attached" role="status">
          Attached as a new mount. This row is now history.
        </p>
      );
  }
}
