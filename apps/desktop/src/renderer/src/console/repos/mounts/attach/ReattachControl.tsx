// Re-attaching one mount's path, from the card that says the mount has drifted.
//
// THE REMEDY FOR THE THIRD HEALTH VERDICT, AND ONLY FOR IT. `Spec-009 §Repo Mount
// Health (V1 Definition)` makes `identity_mismatch` a permanent refusal — the root is
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
// one `repo.attach` caller: the path and the node both come off the mount row, so
// there is no form and nothing to validate, and the settlement renders in the same
// three arms the dialog's does.

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useCallback, useEffect, useRef } from "react";

import type { ConsoleBridge } from "../../../bridge/index.js";
import type { SessionStore } from "../../../store/index.js";
import { InlineRefusal, Nothing, WireFigure } from "../../../primitives/index.js";
import { mountRefusalRecovery } from "../mount-refusal-copy.js";
import { RefusalRecovery } from "../RefusalRecovery.js";
import { useAttachController, type AttachActReading } from "./attach-controller.js";

export interface ReattachControlProps {
  readonly bridge: ConsoleBridge;
  /** The session this mount belongs to, and the source of the roster read's triggers. */
  readonly sessionStore: SessionStore;
  /** The path this mount was attached at. Re-sent verbatim; nothing is re-derived. */
  readonly localPath: string;
  /** The node that owns this mount. The re-attach goes to the same machine. */
  readonly nodeId: string;
  /** Ask the section to read again, so the minted mount appears beside this one. */
  readonly onAttached: () => void;
}

export function ReattachControl(props: ReattachControlProps): React.JSX.Element {
  const { reading, attach, clearAct } = useAttachController(props.bridge, props.sessionStore);
  const { localPath, nodeId, onAttached } = props;

  const confirm = useCallback(() => {
    attach(localPath, nodeId);
  }, [attach, localPath, nodeId]);

  // ONE READ PER MINTED MOUNT, on the dialog's own reasoning: the id is what changes
  // when an attach settles, and a ref is what keeps a re-render from asking again.
  const announcedMountId = useRef<string | undefined>(undefined);
  const mintedMountId =
    reading.act.status === "attached" ? reading.act.response.repoMountId : undefined;
  useEffect(() => {
    if (mintedMountId === undefined || announcedMountId.current === mintedMountId) {
      return;
    }
    announcedMountId.current = mintedMountId;
    onAttached();
  }, [mintedMountId, onAttached]);

  return (
    <div className="meridian-reattach">
      <AlertDialog.Root
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            // The settlement belongs to the press that produced it. A dialog reopened
            // after a refusal must ask the question again, not display the last answer.
            clearAct();
          }
        }}
      >
        <AlertDialog.Trigger
          className="meridian-reattach__trigger"
          disabled={reading.act.status === "sending"}
          aria-label={`Re-attach ${localPath}`}
        >
          Re-attach this path
        </AlertDialog.Trigger>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="meridian-reattach__backdrop" />
          <AlertDialog.Popup className="meridian-reattach__dialog">
            <AlertDialog.Title className="meridian-reattach__title">
              Re-attach this path as a new mount?
            </AlertDialog.Title>
            <AlertDialog.Description className="meridian-reattach__body">
              This mount is not repaired. The path is resolved again on the same node and attached
              as a new mount with its own read-only workspace; this row stays as history, and
              nothing bound to it is moved across.
            </AlertDialog.Description>
            <dl className="meridian-reattach__subject">
              <dt>Path</dt>
              <dd>
                <WireFigure value={localPath} title={localPath} />
              </dd>
              <dt>Node</dt>
              <dd>
                <WireFigure value={nodeId} title={nodeId} />
              </dd>
            </dl>
            <div className="meridian-reattach__acts">
              <AlertDialog.Close className="meridian-reattach__cancel">
                Leave it as it is
              </AlertDialog.Close>
              <AlertDialog.Close className="meridian-reattach__confirm" onClick={confirm}>
                Re-attach
              </AlertDialog.Close>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      {renderSettlement(reading.act)}
    </div>
  );
}

/**
 * What the re-attach did, rendered on the CARD rather than inside the dialog.
 *
 * OUTSIDE THE POPUP DELIBERATELY. The confirmation closes on the press — that is what
 * `AlertDialog.Close` on the confirm control means — so a settlement rendered inside it
 * would be drawn into a popup that is already gone, and a refused re-attach would be
 * silent. On the card it sits beside the verdict it is about.
 */
function renderSettlement(act: AttachActReading): React.JSX.Element | null {
  switch (act.status) {
    case "idle":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Re-attaching." />;
    case "refused": {
      const recovery = mountRefusalRecovery(act.refusal.code);
      return (
        <InlineRefusal
          code={act.refusal.code}
          detail={act.refusal.detail}
          action={recovery === undefined ? undefined : <RefusalRecovery recovery={recovery} />}
        />
      );
    }
    case "attached":
      return (
        <p className="meridian-reattach__attached" role="status">
          Attached as a new mount. This row is now history.
        </p>
      );
  }
}
