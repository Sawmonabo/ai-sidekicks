// Attaching a repository by path: the one entry point for a mount, which belongs to the
// machine rather than the session. A plain `Dialog`, not `AlertDialog`: this is abandonable
// data entry, not consent to a consequence. Attach is not followed by a bind.

import "./AttachRepositoryDialog.css";

import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { OverlayDialogPopup } from "#renderer/components/OverlayPopups/OverlayDialogPopup.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import type { RepoOperations } from "../../operations.js";
import { BUTTON_CLASS_NAME } from "../button-class.js";
import { type AttachRequestReading } from "./controller.js";
import { useAttachController } from "./hooks/useAttachController.js";
import { EMPTY_ATTACH_FORM, resolveAttachForm, type AttachFormState } from "./form.js";
import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
import { StandingContent } from "#renderer/components/LiveAnnouncer/StandingContent.js";

/** What the attach dialog is bound to: the session section, and the call it sends. */
export interface AttachRepositoryDialogProps {
  readonly bridge: PlatformBridge;
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
  const verdict = resolveAttachForm(form);

  const openChanged = useCallback(
    (isOpen: boolean) => {
      if (isOpen) {
        return;
      }
      // Closing clears the settlement with what was typed, so a reopened dialog does not greet
      // the user with the previous path or success sentence.
      setForm(EMPTY_ATTACH_FORM);
      clearAct();
    },
    [clearAct],
  );

  // Re-read on the mint, not the close, keyed on the minted mount id in a ref so one attach
  // asks for one read however often this re-renders.
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
      <Dialog.Trigger className={BUTTON_CLASS_NAME}>Attach a repository</Dialog.Trigger>
      {/* The portal, backdrop and popup are the primitive's, which also registers this dialog in
          the window's airspace so a native browser-pane view yields to it. */}
      <OverlayDialogPopup backdropClassName="meridian-dialog__backdrop" className="meridian-dialog">
        <Dialog.Title className="meridian-dialog__title">Attach a repository</Dialog.Title>
        <Dialog.Description className="meridian-dialog__description">
          Attaching adds the repository to this machine.
        </Dialog.Description>

        <label className="meridian-form__field">
          <span className="meridian-form__label">Path</span>
          <input
            type="text"
            className="meridian-form__input meridian-form__input--wire"
            value={form.localPath}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              // Keep what was typed: a leading or trailing space is a legal POSIX filename
              // character, so trimming would attach a different directory.
              setForm((current) => ({ ...current, localPath: event.target.value }));
            }}
          />
        </label>

        {renderSettlement(reading)}

        <div className="meridian-dialog__actions">
          <Dialog.Close className={BUTTON_CLASS_NAME}>Cancel</Dialog.Close>
          <button
            type="button"
            className={BUTTON_CLASS_NAME}
            disabled={verdict.status !== "sendable" || reading.status === "sending"}
            onClick={submit}
          >
            Attach
          </button>
        </div>
        {/* The reason the control is closed is drawn, since a grayed button reports nothing. The
            reason the dialog opens with stands; one that typing brings is said. */}
        <StandingContent>
          {verdict.status === "incomplete" ? (
            <AnnouncedLine
              element="p"
              className="meridian-form__blocked"
              words={verdict.because}
              politeness="polite"
            />
          ) : null}
        </StandingContent>
      </OverlayDialogPopup>
    </Dialog.Root>
  );
}

/**
 * What the attach did. The attached arm names the mount and its resolved root so a person can
 * find the mount the section is about to grow.
 */
function renderSettlement(reading: AttachRequestReading): React.JSX.Element | null {
  switch (reading.status) {
    case "idle":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Attaching." />;
    case "refused":
      return <InlineRefusal code={reading.refusal.code} detail={reading.refusal.detail} />;
    case "attached":
      return (
        // The line says what happened; the minted mount and root under it are not read out.
        <AnnouncedLine
          element="div"
          className="meridian-form__settlement"
          words="Attached."
          politeness="polite"
        >
          <p>Attached.</p>
          <dl className="meridian-repo-attach__minted">
            <dt>Mount</dt>
            <dd>
              <WireFigure value={reading.response.repoMountId} />
            </dd>
            <dt>Resolved root</dt>
            <dd>
              <WireFigure value={reading.response.canonicalRoot} />
            </dd>
          </dl>
        </AnnouncedLine>
      );
  }
}
