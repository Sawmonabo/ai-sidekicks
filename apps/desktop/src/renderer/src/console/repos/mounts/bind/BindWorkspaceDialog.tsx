// Binding a workspace on a mount the session already holds.
//
// THE SECOND MUTATING ENTRY POINT THIS SECTION LACKED. `Spec-009 §Default Behavior`
// mints one `read-only` workspace at attach and nothing more, so every writable
// workspace in a session arrives through `repo.workspaceBind` — a registered daemon
// method the console reached from nowhere. A person who attached a repository could
// see it and could not put a run in it.
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

import type { ConsoleBridge } from "../../../bridge/index.js";
import { InlineRefusal, Nothing, WireFigure } from "../../../primitives/index.js";
import type { SessionStore } from "../../../store/index.js";
import { mountRefusalRecovery } from "../mount-refusal-copy.js";
import { RefusalRecovery } from "../RefusalRecovery.js";
import { executionModeRows } from "../mode-row.js";
import { BindModePicker } from "./BindModePicker.js";
import { useBindController, type BindReading } from "./bind-controller.js";
import {
  bindFormVerdict,
  defaultBindMode,
  EMPTY_BIND_FORM,
  type BindFormState,
} from "./bind-model.js";

/** The radio group's name. One dialog is open at a time, so one constant serves it. */
const MODE_GROUP_NAME = "meridian-bind-mode";

export interface BindWorkspaceDialogProps {
  readonly bridge: ConsoleBridge;
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
  const { reading, requestCapabilities, retryCapabilities, bind, clearAct } = useBindController(
    props.bridge,
    props.repoMountId,
    props.sessionStore,
  );
  const [form, setForm] = useState<BindFormState>(EMPTY_BIND_FORM);
  const verdict = bindFormVerdict(form);

  const openChanged = useCallback(
    (isOpen: boolean) => {
      if (isOpen) {
        requestCapabilities();
        return;
      }
      // A dialog reopened to bind a second workspace must not greet its participant
      // with the first one's directory, mode, or settlement. The capabilities reading
      // is deliberately untouched — it is the same answer.
      setForm(EMPTY_BIND_FORM);
      clearAct();
    },
    [requestCapabilities, clearAct],
  );

  // THE DAEMON'S DEFAULT IS PRE-FILLED ONCE THE READ LANDS, and only into a form nobody
  // has touched: a later re-read must not move a mode a participant has chosen. Held in
  // a ref rather than derived, because the pre-fill is an event and not a state.
  const preFilledFor = useRef<string | undefined>(undefined);
  const served = reading.prerequisite.status === "read" ? reading.prerequisite.value : undefined;
  useEffect(() => {
    if (served === undefined || preFilledFor.current === props.repoMountId) {
      return;
    }
    preFilledFor.current = props.repoMountId;
    const daemonDefault = defaultBindMode(served);
    if (daemonDefault === undefined) {
      return;
    }
    setForm((current) =>
      current.executionMode === undefined ? { ...current, executionMode: daemonDefault } : current,
    );
  }, [served, props.repoMountId]);

  // ONE READ PER BOUND WORKSPACE, on the attach dialog's reasoning: the id is what
  // changes when a bind settles, and a ref keeps a re-render from asking again.
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
    <Dialog.Root onOpenChange={openChanged}>
      <Dialog.Trigger className="meridian-bind__trigger">Bind a workspace</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="meridian-bind__backdrop" />
        <Dialog.Popup className="meridian-bind__dialog">
          <Dialog.Title className="meridian-bind__title">Bind a workspace</Dialog.Title>
          <Dialog.Description className="meridian-bind__body">
            A workspace is a binding of this mount in one execution mode. Leaving the directory
            empty binds the mount root.
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

          {renderModes(reading, form.executionMode, selectMode, retryCapabilities)}
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
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The mode half, per arm of the pre-bind read.
 *
 * A REFUSED READ LEAVES THE DIRECTORY FIELD ALONE AND SAYS SO, on the attach dialog's
 * reason: the directory is still worth typing, the read may answer on a retry, and a
 * dialog that vanished would take the participant's typing with it.
 */
function renderModes(
  reading: BindReading,
  selectedMode: string | undefined,
  onSelect: (mode: ExecutionMode) => void,
  onRetry: () => void,
): React.JSX.Element {
  switch (reading.prerequisite.status) {
    case "not-read":
      return <Nothing kind="not-checked" title="What this mount admits has not been read." />;
    case "reading":
      return <Nothing kind="computing" title="Reading what this mount admits." />;
    case "refused":
      return (
        <div className="meridian-bind__modes-refusal">
          <InlineRefusal
            code={reading.prerequisite.refusal.code}
            detail={reading.prerequisite.refusal.detail}
          />
          <button type="button" className="meridian-bind__retry" onClick={onRetry}>
            Read the modes again
          </button>
        </div>
      );
    case "read":
      return (
        <BindModePicker
          options={executionModeRows(reading.prerequisite.value)}
          selectedMode={selectedMode}
          groupName={MODE_GROUP_NAME}
          onSelect={onSelect}
        />
      );
  }
}

/**
 * What came back, on both arms, never swallowed.
 *
 * THE PROVISIONING ARM IS A SETTLEMENT AND NOT A FAILURE. A writable bind answers with
 * no `fsRoot` because the execution root does not exist yet, and a dialog that read the
 * absence as an error would report a bind that worked as one that did not.
 *
 * THE REFUSAL CARRIES THIS FAMILY'S RECOVERY, AND NO RESTRICTION SENTENCE. The mount's
 * own reason for an excluded mode is served per MODE, and a `workspace.mode_unsupported`
 * refusal names no mode — so pairing one here would mean reading a mode out of the
 * daemon's prose, which the daemon is free to reword. The recovery table's own arm
 * answers instead, and it says exactly that: the read named no reason for it.
 */
function renderSettlement(reading: BindReading): React.JSX.Element | null {
  const { act } = reading;
  switch (act.status) {
    case "idle":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Binding this workspace." />;
    case "refused": {
      const recovery = mountRefusalRecovery(act.refusal.code);
      return (
        <InlineRefusal
          code={act.refusal.code}
          detail={act.refusal.detail}
          {...(recovery === undefined ? {} : { action: <RefusalRecovery recovery={recovery} /> })}
        />
      );
    }
    case "bound":
      return (
        <div className="meridian-bind__settlement" role="status">
          <p className="meridian-bind__settlement-line">
            Bound as <WireFigure value={act.response.executionMode} title="execution mode" /> in
            state <WireFigure value={act.response.state} title="workspace state" />.
          </p>
          {act.response.fsRoot === undefined ? (
            <Nothing
              kind="computing"
              title="The execution root is being provisioned; the card reports it when it lands."
            />
          ) : (
            <WireFigure value={act.response.fsRoot} title={act.response.fsRoot} />
          )}
        </div>
      );
  }
}
