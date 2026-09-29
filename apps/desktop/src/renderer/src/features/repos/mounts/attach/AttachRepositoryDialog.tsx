// Attaching a repository: the path, and what came back.
//
// THE ENTRY POINT FOR A REPOSITORY: a mount arrives through this dialog. A mount belongs to
// the machine rather than to the session.
//
// A DIALOG RATHER THAN AN INLINE FORM, so a sidebar section whose subject is the mounts a
// session already has does not also carry a text field and a settlement.
//
// IT IS `Dialog` AND NOT `AlertDialog`. The alert variant is for a consequence a person
// is consenting to, and it traps escape and outside-press for that reason; this is data
// entry a person may abandon, and abandoning it costs nothing. The RE-ATTACH beside it
// is the other case and takes the alert variant, in its own module.
//
// THE ATTACH IS NOT FOLLOWED BY A BIND. A bind issued here would be the console choosing
// an execution mode nobody asked for, which is why the settlement below names the mount
// rather than offering a mode.

import "./attach.css";

import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { Nothing, OverlayDialogPopup, WireFigure } from "@renderer/console/primitives/index.js";
import type { RepoOperations } from "../../repo-operations.js";
import { type AttachRequestReading } from "./attach-controller.js";
import { useAttachController } from "./hooks/useAttachController.js";
import { EMPTY_ATTACH_FORM, resolveAttachForm, type AttachFormState } from "./attach-form.js";

/** What the attach dialog is bound to: the session section, and the call it sends. */
export interface AttachRepositoryDialogProps {
  readonly bridge: ConsoleBridge;
  /** The attach the dialog sends. */
  readonly operations: Pick<RepoOperations, "attachRepository">;
  /** The session whose section the dialog is drawn in. */
  readonly sessionId: string;
  /** Ask the section to read again once an attach has minted a mount. */
  readonly onAttached: () => void;
}

/** The dialog that attaches one local checkout to the session by its path. */
export function AttachRepositoryDialog(props: AttachRepositoryDialogProps): React.JSX.Element {
  const { reading, attach, clearAct } = useAttachController(
    props.bridge,
    props.sessionId,
    props.operations,
  );
  const [form, setForm] = useState<AttachFormState>(EMPTY_ATTACH_FORM);
  const { verdict } = resolveAttachForm(form);

  const openChanged = useCallback(
    (isOpen: boolean) => {
      if (isOpen) {
        return;
      }
      // CLOSING CLEARS THE SETTLEMENT WITH WHAT THE USER TYPED: a dialog reopened to
      // attach a second repository must not greet its user with the first one's path or
      // success sentence.
      setForm(EMPTY_ATTACH_FORM);
      clearAct();
    },
    [clearAct],
  );

  // THE SECTION RE-READS ON THE MINT AND NOT ON THE CLOSE, because the two are
  // different moments and the second is optional. Keyed on the minted mount id and held
  // in a ref, so one attach asks for one read however many times this component
  // re-renders.
  const announcedMountId = useRef<string | undefined>(undefined);
  const mintedMountId = reading.status === "attached" ? reading.response.repoMountId : undefined;
  const { onAttached } = props;
  useEffect(() => {
    if (mintedMountId === undefined || announcedMountId.current === mintedMountId) {
      return;
    }
    announcedMountId.current = mintedMountId;
    onAttached();
  }, [mintedMountId, onAttached]);

  const submit = useCallback(() => {
    if (verdict.status !== "sendable") {
      return;
    }
    attach(verdict.localPath);
  }, [attach, verdict]);

  return (
    <Dialog.Root onOpenChange={openChanged} modal="trap-focus">
      <Dialog.Trigger className="meridian-repo-attach__trigger">Attach a repository</Dialog.Trigger>
      {/* The popup shell is the primitive's, which is also what puts this dialog in the
          window's airspace: a native browser-pane view yields to whatever is registered
          there, and a form that mounted its own portal would be a dialog the view paints
          over. */}
      <OverlayDialogPopup
        backdropClassName="meridian-repo-attach__backdrop"
        className="meridian-repo-attach__dialog"
      >
        <Dialog.Title className="meridian-repo-attach__title">Attach a repository</Dialog.Title>
        <Dialog.Description className="meridian-repo-attach__body">
          Attaching adds the repository to this machine. Choosing an execution mode is a separate
          step, taken when a workspace is bound on it.
        </Dialog.Description>

        <label className="meridian-repo-attach__path">
          <span className="meridian-repo-attach__legend">Path</span>
          <input
            type="text"
            className="meridian-repo-attach__path-input"
            value={form.localPath}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              // WHAT WAS TYPED, UNCHANGED. A leading or trailing space is a legal
              // POSIX filename character, so trimming here would attach a different
              // directory from the one that was named.
              setForm((current) => ({ ...current, localPath: event.target.value }));
            }}
          />
        </label>

        {renderSettlement(reading)}

        <div className="meridian-repo-attach__acts">
          <Dialog.Close className="meridian-repo-attach__cancel">Cancel</Dialog.Close>
          <button
            type="button"
            className="meridian-repo-attach__confirm"
            disabled={verdict.status !== "sendable" || reading.status === "sending"}
            onClick={submit}
          >
            Attach
          </button>
        </div>
        {/* The reason the control is closed, always said: a grayed button with nothing
            beside it reports nothing. */}
        {verdict.status === "incomplete" ? (
          <p className="meridian-repo-attach__blocked" role="status">
            {verdict.because}
          </p>
        ) : null}
      </OverlayDialogPopup>
    </Dialog.Root>
  );
}

/**
 * What the attach did.
 *
 * The attached arm names the mount and the root it resolved to, because a person needs to
 * be able to find the mount the section is about to grow.
 */
function renderSettlement(reading: AttachRequestReading): React.JSX.Element | null {
  switch (reading.status) {
    case "idle":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Attaching." />;
    case "attached":
      return (
        <div className="meridian-repo-attach__attached" role="status">
          <p>Attached.</p>
          <dl className="meridian-repo-attach__minted">
            <dt>Mount</dt>
            <dd>
              <WireFigure
                value={reading.response.repoMountId}
                title={reading.response.repoMountId}
              />
            </dd>
            <dt>Resolved root</dt>
            <dd>
              <WireFigure
                value={reading.response.canonicalRoot}
                title={reading.response.canonicalRoot}
              />
            </dd>
          </dl>
        </div>
      );
  }
}
