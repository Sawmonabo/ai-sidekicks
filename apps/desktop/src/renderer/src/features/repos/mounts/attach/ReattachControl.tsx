// Re-attaching one mount's path, offered only for `identity_mismatch`: the root is reachable
// but holds a different repository from the one the mount was attached as. Not offered for
// `unreachable`, which is transient and would invite a duplicate mount row. An alert dialog,
// because re-attach does not repair the mount: it mints a new one and this row stays. It
// reuses the attach controller and `hooks/useConfirmationLifecycle.ts`, whose discard rule
// handles the confirm press closing the dialog.

import "./attach.css";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useCallback, useEffect, useRef } from "react";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { OverlayAlertDialogPopup } from "#renderer/components/OverlayPopups/OverlayAlertDialogPopup.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import type { RepoOperations } from "../../repo-operations.js";
import { BUTTON_CLASS_NAME } from "../button-class.js";
import { useConfirmationLifecycle } from "../hooks/useConfirmationLifecycle.js";
import { type AttachRequestReading } from "./attach-controller.js";
import { useAttachController } from "./hooks/useAttachController.js";

/** Props for the re-attach confirmation. */
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

/** The confirmation that re-attaches a drifted mount's path as a new mount. */
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
  // The settlement belongs to the press that produced it: a reopened dialog asks again, a
  // canceled one discards the answer, and the confirm press (which closes it) discards nothing.
  const lifecycle = useConfirmationLifecycle(clearAct);

  // One read per minted mount: the id changes when an attach settles, and a ref stops a
  // re-render asking again.
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
          className={BUTTON_CLASS_NAME}
          disabled={reading.status === "sending"}
          aria-label={`Re-attach ${localPath}`}
        >
          Re-attach this path
        </AlertDialog.Trigger>
        {/* The portal, backdrop and popup are the primitive's, which registers this
            confirmation in the window's airspace so a native browser-pane view yields to it. */}
        <OverlayAlertDialogPopup
          backdropClassName="meridian-dialog__backdrop"
          className="meridian-dialog"
        >
          <AlertDialog.Title className="meridian-dialog__title">
            Re-attach this path as a new mount?
          </AlertDialog.Title>
          <AlertDialog.Description className="meridian-dialog__description">
            This mount is not repaired. The path is resolved again and attached as a new mount; this
            row stays as history, and nothing bound to it is moved across.
          </AlertDialog.Description>
          <dl className="meridian-reattach__subject">
            <dt>Path</dt>
            <dd>
              <WireFigure value={localPath} title={localPath} />
            </dd>
          </dl>
          <div className="meridian-dialog__actions">
            <AlertDialog.Close className={BUTTON_CLASS_NAME} onClick={lifecycle.canceled}>
              Leave it as it is
            </AlertDialog.Close>
            <AlertDialog.Close className={BUTTON_CLASS_NAME} onClick={confirm}>
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
 * What the re-attach did, rendered on the card rather than inside the dialog: the
 * confirmation closes on the press, so a settlement inside it would draw into a gone popup.
 */
function renderSettlement(act: AttachRequestReading): React.JSX.Element | null {
  switch (act.status) {
    case "idle":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Re-attaching." />;
    case "refused":
      return <InlineRefusal code={act.refusal.code} detail={act.refusal.detail} />;
    case "attached":
      return (
        <p className="meridian-form__settlement" role="status">
          Attached as a new mount. This row is now history.
        </p>
      );
  }
}
