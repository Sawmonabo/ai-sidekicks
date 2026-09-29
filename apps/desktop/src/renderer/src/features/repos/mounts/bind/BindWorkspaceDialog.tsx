// Binding a workspace on a mount the session already holds.
//
// A BIND IS HOW A WORKSPACE ARRIVES. Attach mints a mount and no workspace, so a person
// who attached a repository binds one, in the mode they want, to put a run on it.
//
// IT IS `Dialog` AND NOT `AlertDialog`. This is data entry a person may abandon at no
// cost; the alert variant is for a consequence being consented to, which is what the
// re-attach and the root disposals use.
//
// IT IS OFFERED ONLY WHERE THE CARD OFFERS BIND CONTROLS AT ALL, which the card decides
// from the mount's lifecycle and health axes — so a detached, unreachable, or drifted
// mount renders the withheld sentence rather than this trigger. The daemon would refuse
// such a bind anyway; the point is that the reason is already on screen.

import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ExecutionMode } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { Nothing, OverlayDialogPopup, WireFigure } from "@renderer/console/primitives/index.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";
import type { RepoOperations } from "../../repo-operations.js";
import { executionModeRows } from "../execution-mode-rows.js";
import { BindModePicker } from "./BindModePicker.js";
import { type BindReading } from "./bind-controller.js";
import { useBindController } from "./hooks/useBindController.js";
import { EMPTY_BIND_FORM, resolveBindForm, type BindFormState } from "./bind-form.js";

/** The radio group's name. One dialog is open at a time, so one constant serves it. */
const MODE_GROUP_NAME = "meridian-bind-mode";

export interface BindWorkspaceDialogProps {
  readonly bridge: ConsoleBridge;
  /** The pre-bind read and the bind the dialog sends. */
  readonly operations: Pick<RepoOperations, "bindWorkspace" | "readMountExecutionModes">;
  /** The mount a new workspace binds on. */
  readonly repoMountId: string;
  /** The root a relative directory is resolved against. Shown, never joined here. */
  readonly canonicalRoot: string;
  /** The session whose reconnect edge and repo frames re-ask the pre-bind question. */
  readonly sessionStore: SessionStore;
  /** Ask the section to read again, so the bound workspace appears on this card. */
  readonly onBound: () => void;
}

export function BindWorkspaceDialog(props: BindWorkspaceDialogProps): React.JSX.Element {
  const { reading, requestCapabilities, bind, clearAct } = useBindController(
    props.bridge,
    props.repoMountId,
    props.sessionStore,
    props.operations,
  );
  const [form, setForm] = useState<BindFormState>(EMPTY_BIND_FORM);
  // WHAT THIS MOUNT ADMITS IS AN INPUT TO BOTH HALVES OF THIS DIALOG. The daemon's own
  // default arrives through the same reading that opens the control, so a dialog
  // reopened on this mount gets it again; and a refresh that withdraws the held mode
  // clears the radio and shuts the control in one act, rather than drawing the row
  // excluded beside a button that would still send it.
  const servedCapabilities =
    reading.prerequisite.status === "read" ? reading.prerequisite.value : undefined;
  const { selectedMode, verdict } = resolveBindForm(form, servedCapabilities);

  const openChanged = useCallback(
    (isOpen: boolean) => {
      if (isOpen) {
        requestCapabilities();
        return;
      }
      // A dialog reopened to bind a second workspace must not greet its user
      // with the first one's directory, mode, or settlement. The capabilities reading
      // is deliberately untouched — it is the same answer.
      setForm(EMPTY_BIND_FORM);
      clearAct();
    },
    [requestCapabilities, clearAct],
  );

  // ONE READ PER BOUND WORKSPACE: the id is what changes when a bind settles, and a ref
  // keeps a re-render from asking again.
  const announcedWorkspaceId = useRef<string | undefined>(undefined);
  const boundWorkspaceId =
    reading.act.status === "bound" ? reading.act.response.workspaceId : undefined;
  const { onBound } = props;
  useEffect(() => {
    if (boundWorkspaceId === undefined || announcedWorkspaceId.current === boundWorkspaceId) {
      return;
    }
    announcedWorkspaceId.current = boundWorkspaceId;
    onBound();
  }, [boundWorkspaceId, onBound]);

  const selectMode = useCallback((executionMode: ExecutionMode) => {
    setForm((current) => ({ ...current, executionMode }));
  }, []);

  const submit = useCallback(() => {
    if (verdict.status !== "sendable") {
      return;
    }
    bind(verdict.executionMode, verdict.directory);
  }, [bind, verdict]);

  return (
    <Dialog.Root onOpenChange={openChanged} modal="trap-focus">
      <Dialog.Trigger className="meridian-bind__trigger">Bind a workspace</Dialog.Trigger>
      {/* The popup shell is the primitive's, which is also what puts this dialog in the
          window's airspace: a native browser-pane view yields to whatever is
          registered there, and a form that
          mounted its own portal would be a dialog the view paints over. */}
      <OverlayDialogPopup
        backdropClassName="meridian-bind__backdrop"
        className="meridian-bind__dialog"
      >
        <Dialog.Title className="meridian-bind__title">Bind a workspace</Dialog.Title>
        <Dialog.Description className="meridian-bind__body">
          A workspace is a binding of this mount in one execution mode. Leaving the directory empty
          binds the mount root.
        </Dialog.Description>
        <p className="meridian-bind__root">
          <span className="meridian-bind__legend">Mount root</span>
          <WireFigure value={props.canonicalRoot} title={props.canonicalRoot} />
        </p>

        <label className="meridian-bind__directory">
          <span className="meridian-bind__legend">Directory</span>
          <input
            type="text"
            className="meridian-bind__directory-input"
            value={form.directory}
            spellCheck={false}
            autoComplete="off"
            placeholder="the mount root"
            onChange={(event) => {
              // WHAT WAS TYPED, UNCHANGED. The wire takes a subtree relative to the
              // canonical root or an absolute path naming a registered working tree,
              // over one member — this console splits neither and joins nothing.
              setForm((current) => ({ ...current, directory: event.target.value }));
            }}
          />
        </label>

        {renderModes(reading, selectedMode, selectMode)}
        {renderSettlement(reading)}

        <div className="meridian-bind__acts">
          <Dialog.Close className="meridian-bind__cancel">Cancel</Dialog.Close>
          <button
            type="button"
            className="meridian-bind__confirm"
            disabled={verdict.status !== "sendable" || reading.act.status === "sending"}
            onClick={submit}
          >
            Bind
          </button>
        </div>
        {verdict.status === "incomplete" ? (
          <p className="meridian-bind__blocked" role="status">
            {verdict.because}
          </p>
        ) : null}
      </OverlayDialogPopup>
    </Dialog.Root>
  );
}

/** The mode half, per arm of the pre-bind read. */
function renderModes(
  reading: BindReading,
  selectedMode: string | undefined,
  onSelect: (mode: ExecutionMode) => void,
): React.JSX.Element | null {
  switch (reading.prerequisite.status) {
    case "not-read":
      return <Nothing kind="not-checked" title="What this mount admits has not been read." />;
    case "reading":
      return <Nothing kind="computing" title="Reading what this mount admits." />;
    case "read":
      return (
        <BindModePicker
          options={executionModeRows(reading.prerequisite.value)}
          // Already resolved against these capabilities by `resolveBindForm`: the daemon's
          // default arrives checked and a withdrawn mode arrives as nothing checked. A
          // pre-fill written into form state instead needed a memory of having run, and
          // that memory outlived the form it was taken about.
          selectedMode={selectedMode}
          groupName={MODE_GROUP_NAME}
          onSelect={onSelect}
        />
      );
  }
}

/**
 * What the bind did.
 *
 * The bind answers with the mode it bound and the workspace's state, and no root: a
 * `provisioning` answer is a bind that worked, and the card reports the root from the
 * workspace list once it exists.
 */
function renderSettlement(reading: BindReading): React.JSX.Element | null {
  const { act } = reading;
  switch (act.status) {
    case "idle":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Binding this workspace." />;
    case "bound":
      return (
        <div className="meridian-bind__settlement" role="status">
          <p className="meridian-bind__settlement-line">
            Bound as <WireFigure value={act.response.executionMode} title="execution mode" /> in
            state <WireFigure value={act.response.state} title="workspace state" />.
          </p>
        </div>
      );
  }
}
