// Binding a workspace on a mount the session already holds: attach mints a mount and no
// workspace, so a bind is how a workspace arrives. A plain `Dialog`, not `AlertDialog`, since
// this is abandonable data entry. The card offers the trigger only where the mount's lifecycle
// and health admit a bind, so the reason is already on screen otherwise.

import "./bind.css";

import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ExecutionMode } from "@ai-sidekicks/contracts/repo/repo";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { OverlayDialogPopup } from "#renderer/components/OverlayPopups/OverlayDialogPopup.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import type { SessionStore } from "#renderer/store/session/session-store.js";
import type { RepoOperations } from "../../repo-operations.js";
import { executionModeRows } from "../execution-mode/execution-mode-rows.js";
import { BindModePicker } from "./BindModePicker.js";
import { type BindReading } from "./controller.js";
import { useBindController } from "./hooks/useBindController.js";
import { EMPTY_BIND_FORM, resolveBindForm, type BindFormState } from "./form.js";

/** The radio group's name. One dialog is open at a time, so one constant serves it. */
const MODE_GROUP_NAME = "meridian-bind-mode";

/** Props for the bind dialog. */
export interface BindWorkspaceDialogProps {
  readonly bridge: PlatformBridge;
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

/** The dialog that binds a workspace on one mount, in an execution mode the mount admits. */
export function BindWorkspaceDialog(props: BindWorkspaceDialogProps): React.JSX.Element {
  const { reading, requestCapabilities, bind, clearAct } = useBindController(
    props.bridge,
    props.repoMountId,
    props.sessionStore,
    props.operations,
  );
  const [form, setForm] = useState<BindFormState>(EMPTY_BIND_FORM);
  // What this mount admits feeds both halves of the dialog: the daemon's default arrives
  // through the reading that opens the control, and a refresh that withdraws the held mode
  // clears the radio and shuts the control together.
  const servedCapabilities =
    reading.prerequisite.status === "read" ? reading.prerequisite.value : undefined;
  const { selectedMode, verdict } = resolveBindForm(form, servedCapabilities);

  const openChanged = useCallback(
    (isOpen: boolean) => {
      if (isOpen) {
        requestCapabilities();
        return;
      }
      // A reopened dialog must not greet its user with the previous directory, mode or
      // settlement. The capabilities reading is untouched; it is the same answer.
      setForm(EMPTY_BIND_FORM);
      clearAct();
    },
    [requestCapabilities, clearAct],
  );

  // One read per bound workspace: the id changes when a bind settles, and a ref stops a
  // re-render asking again.
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
      {/* The portal, backdrop and popup are the primitive's, which registers this dialog in
          the window's airspace so a native browser-pane view yields to it. */}
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
              // Keep what was typed: the wire takes a subtree relative to the canonical root or
              // an absolute path naming a registered working tree, and this console splits and
              // joins nothing.
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
        {/* A refused read draws its refusal with the modes, which this line would contradict. */}
        {verdict.status === "incomplete" && reading.prerequisite.status !== "refused" ? (
          <p className="meridian-bind__blocked" role="status">
            {verdict.because}
          </p>
        ) : null}
      </OverlayDialogPopup>
    </Dialog.Root>
  );
}

/** The mode half of the dialog, per arm of the pre-bind read. */
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
    case "refused":
      return (
        <InlineRefusal
          code={reading.prerequisite.refusal.code}
          detail={reading.prerequisite.refusal.detail}
        />
      );
    case "read":
      return (
        <BindModePicker
          options={executionModeRows(reading.prerequisite.value)}
          // Already resolved against these capabilities by `resolveBindForm`: the daemon's
          // default arrives checked and a withdrawn mode arrives as nothing checked.
          selectedMode={selectedMode}
          groupName={MODE_GROUP_NAME}
          onSelect={onSelect}
        />
      );
  }
}

/**
 * What the bind did. The answer carries the mode and workspace state but no root: a
 * `preparing` answer is a bind that worked, and the card reports the root once the workspace
 * exists.
 */
function renderSettlement(reading: BindReading): React.JSX.Element | null {
  const { act } = reading;
  switch (act.status) {
    case "idle":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Binding this workspace." />;
    case "refused":
      return <InlineRefusal code={act.refusal.code} detail={act.refusal.detail} />;
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
