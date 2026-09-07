// Attaching a repository to this session: the path, the node, and what came back.
//
// THE SECTION'S ONE MUTATING ENTRY POINT, and it was missing entirely — the empty-list
// card said attach "is reached through the command-line and SDK surfaces today", which
// was true of this console and false of the wire: `repo.attach` and `repo.workspaceBind`
// are registered daemon methods, so the desktop had no way to start a session's first
// repository while the daemon had one all along.
//
// A DIALOG RATHER THAN AN INLINE FORM, because the act has two inputs and one of them
// is a choice over a list that has to be read first. An inline form would put a roster
// read, a radio group, and a settlement into a sidebar section whose subject is the
// mounts a session already has — and would read every session's roster whether or not
// anyone was attaching.
//
// IT IS `Dialog` AND NOT `AlertDialog`. The alert variant is for a consequence a person
// is consenting to, and it traps escape and outside-press for that reason; this is data
// entry a person may abandon, and abandoning it costs nothing. The RE-ATTACH beside it
// is the other case and takes the alert variant, in its own module.
//
// THE ATTACH IS NOT FOLLOWED BY A BIND. `Spec-009 §Default Behavior` mints one
// `read-only` workspace at attach unconditionally, and the reply names it — so a bind
// issued here would be the console choosing an execution mode nobody asked for. The
// mode picker on the workspace card is where that choice is made, which is why the
// settlement below names the workspace rather than offering to change it.

import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ConsoleBridge } from "../../../bridge/index.js";
import type { SessionStore } from "../../../store/index.js";
import {
  InlineRefusal,
  Nothing,
  OverlayDialogPopup,
  WireFigure,
} from "../../../primitives/index.js";
import { mountRefusalRecovery } from "../mount-refusal-copy.js";
import { RefusalRecovery } from "../RefusalRecovery.js";
import { useAttachController, type AttachReading } from "./attach-controller.js";
import { EMPTY_ATTACH_FORM, resolveAttachForm, type AttachFormState } from "./attach-model.js";
import { NodePicker } from "./NodePicker.js";

/** The radio group's name. One dialog is open at a time, so one constant serves it. */
const NODE_GROUP_NAME = "meridian-attach-node";

export interface AttachRepositoryDialogProps {
  readonly bridge: ConsoleBridge;
  /** The session attached to, and the source of the roster read's refresh triggers. */
  readonly sessionStore: SessionStore;
  /** Ask the section to read again, so a minted mount appears without a second act. */
  readonly onAttached: () => void;
}

export function AttachRepositoryDialog(props: AttachRepositoryDialogProps): React.JSX.Element {
  const { reading, requestRoster, retryRoster, attach, clearAct } = useAttachController(
    props.bridge,
    props.sessionStore,
  );
  const [form, setForm] = useState<AttachFormState>(EMPTY_ATTACH_FORM);
  // THE ROSTER ON SCREEN IS AN INPUT TO BOTH HALVES OF THIS DIALOG, which is what keeps
  // the picker and the Attach button from disagreeing: the sole-node default that makes
  // the radio checked is the same reading that makes the control open, and a refresh
  // that drops the picked node clears the radio and shuts the control in one act.
  const servedNodes =
    reading.prerequisite.status === "read" ? reading.prerequisite.value : undefined;
  const { selectedNodeId, verdict } = resolveAttachForm(form, servedNodes);

  const openChanged = useCallback(
    (isOpen: boolean) => {
      if (isOpen) {
        requestRoster();
        return;
      }
      // CLOSING RESETS BOTH HALVES OF WHAT THE PARTICIPANT SUPPLIED, and clears the
      // settlement with them: a dialog reopened to attach a second repository must not
      // greet its participant with the first one's path, node, or success sentence.
      // The roster reading is deliberately untouched — it is the same answer.
      setForm(EMPTY_ATTACH_FORM);
      clearAct();
    },
    [requestRoster, clearAct],
  );

  const selectNode = useCallback((nodeId: string) => {
    setForm((current) => ({ ...current, nodeId }));
  }, []);

  // THE SECTION RE-READS ON THE MINT AND NOT ON THE CLOSE, because the two are
  // different moments and the second is optional: a participant who attaches and then
  // reads the settlement without closing the dialog would otherwise see a section that
  // still says the session holds nothing. Keyed on the minted mount id and held in a
  // ref, so one attach asks for one read however many times this component re-renders.
  const announcedMountId = useRef<string | undefined>(undefined);
  const mintedMountId =
    reading.act.status === "attached" ? reading.act.response.repoMountId : undefined;
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
    attach(verdict.localPath, verdict.nodeId);
  }, [attach, verdict]);

  return (
    <Dialog.Root onOpenChange={openChanged}>
      <Dialog.Trigger className="meridian-repo-attach__trigger">Attach a repository</Dialog.Trigger>
      {/* The popup shell is the primitive's, which is also what puts this dialog in the
          window's airspace (`Spec-023 §Console Design (Meridian)` 12.3): a native
          browser-pane view yields to whatever is registered there, and a form that
          mounted its own portal would be a dialog the view paints over. */}
      <OverlayDialogPopup
        backdropClassName="meridian-repo-attach__backdrop"
        className="meridian-repo-attach__dialog"
      >
        <Dialog.Title className="meridian-repo-attach__title">Attach a repository</Dialog.Title>
        <Dialog.Description className="meridian-repo-attach__body">
          The path is resolved on the node that holds it. Attaching mints one read-only workspace;
          choosing an execution mode is a separate step on the workspace itself.
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

        {renderRoster(reading, selectedNodeId, selectNode, retryRoster)}
        {renderSettlement(reading)}

        <div className="meridian-repo-attach__acts">
          <Dialog.Close className="meridian-repo-attach__cancel">Cancel</Dialog.Close>
          <button
            type="button"
            className="meridian-repo-attach__confirm"
            disabled={verdict.status !== "sendable" || reading.act.status === "sending"}
            onClick={submit}
          >
            Attach
          </button>
        </div>
        {/*
            THE REASON THE CONTROL IS CLOSED, ALWAYS SAID. Rule 8 forbids a silent
            refusal, and a greyed button with nothing beside it is one: this line names
            the one thing missing, in the order a person fills the form in.
          */}
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
 * The node half, per arm of the roster read.
 *
 * A REFUSED ROSTER LEAVES THE PATH FIELD ALONE AND SAYS SO, rather than closing the
 * dialog: the path is still worth typing, the roster may answer on a retry, and a
 * dialog that vanished would take the participant's typing with it.
 *
 * THE RETRY IS A CONTROL AND NOT A TIMER, which is `Spec-023 §Rules every console
 * surface obeys`: a participant asking again is one of the three admitted refresh
 * reasons, and an interval behind this dialog is the polling that rule forbids.
 */
function renderRoster(
  reading: AttachReading,
  selectedNodeId: string | undefined,
  onSelect: (nodeId: string) => void,
  onRetry: () => void,
): React.JSX.Element {
  switch (reading.prerequisite.status) {
    case "not-read":
      return <Nothing kind="not-checked" title="The session's nodes have not been read." />;
    case "reading":
      return <Nothing kind="computing" title="Reading this session's nodes." />;
    case "refused":
      return (
        <div className="meridian-repo-attach__roster-refusal">
          <InlineRefusal
            code={reading.prerequisite.refusal.code}
            detail={reading.prerequisite.refusal.detail}
          />
          <button type="button" className="meridian-repo-attach__retry" onClick={onRetry}>
            Read the nodes again
          </button>
        </div>
      );
    case "read":
      return reading.prerequisite.value.length === 0 ? (
        <Nothing
          kind="empty"
          title="No node is attached to this session."
          detail="A repository is attached on the machine that holds it, so a session with no node has nothing to attach through."
        />
      ) : (
        <NodePicker
          options={reading.prerequisite.value}
          // ALREADY RESOLVED AGAINST THIS ROSTER, by `resolveAttachForm`. The sole node
          // arrives here pre-selected because there is no decision to make; two or more
          // and nothing is checked, because the path is on one of them and only the
          // participant knows which. The fallback used to be written here, which is how
          // the picker and the verdict came to disagree — a checked radio the form never
          // held, over a control that would not send.
          selectedNodeId={selectedNodeId}
          groupName={NODE_GROUP_NAME}
          onSelect={onSelect}
        />
      );
  }
}

/**
 * What the attach did, on whichever arm it settled.
 *
 * THE SUCCESS ARM NAMES THE MOUNT AND ITS DEFAULT WORKSPACE, because those are the two
 * rows the section is about to grow and a person needs to be able to find them. The
 * refusal arm carries this family's recovery in the shape's own `action` slot rather
 * than beside it, so one refusal reads as one fact.
 */
function renderSettlement(reading: AttachReading): React.JSX.Element | null {
  switch (reading.act.status) {
    case "idle":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Attaching." />;
    case "refused": {
      const recovery = mountRefusalRecovery(reading.act.refusal.code);
      return (
        <InlineRefusal
          code={reading.act.refusal.code}
          detail={reading.act.refusal.detail}
          action={recovery === undefined ? undefined : <RefusalRecovery recovery={recovery} />}
        />
      );
    }
    case "attached":
      return (
        <div className="meridian-repo-attach__attached" role="status">
          <p>Attached. Its default read-only workspace is ready.</p>
          <dl className="meridian-repo-attach__minted">
            <dt>Mount</dt>
            <dd>
              <WireFigure
                value={reading.act.response.repoMountId}
                title={reading.act.response.repoMountId}
              />
            </dd>
            <dt>Resolved root</dt>
            <dd>
              <WireFigure
                value={reading.act.response.canonicalRoot}
                title={reading.act.response.canonicalRoot}
              />
            </dd>
            <dt>Workspace</dt>
            <dd>
              <WireFigure
                value={reading.act.response.defaultWorkspaceId}
                title={reading.act.response.defaultWorkspaceId}
              />
            </dd>
          </dl>
        </div>
      );
  }
}
