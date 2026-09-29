// Putting an execution root on disk for one workspace, ahead of any run.
//
// THE REUSE CHECK IS THE SURFACE, not a step hidden behind the button. A person naming
// a branch is asking a question the daemon can already answer — is there a checkout of
// this branch, is it clean, is it usable — and the answer decides whether the prepare
// they are about to send is a create, a reuse, a reuse that needs their consent, or a
// refusal no consent lifts. So the verdict is drawn under the field as the name is
// settled, and the control below it changes with it.
//
// THE CONSENT IS A CHECKBOX THAT EXISTS ONLY FOR THE DIRTY VERDICT, and never a
// permanently visible one that is sometimes ignored. `acknowledgeDirtyCandidate` means
// one thing — this person has read that the candidate has uncommitted work in it and
// wants to run there anyway — and a box that were always present would collect that
// consent for the case that does not need it and, worse, would look like the override
// for the case that has none. What the box RECORDS is the candidate's own id, so the
// consent belongs to one tree rather than to the branch text that found it.
//
// AND THE CONTROL IS SHUT WHILE THE CHECK IS IN FLIGHT. The verdict is what decides
// whether the prepare names a candidate at all, so a form that were sendable during the
// debounce window would send a prepare with no `reuseWorktreeId` against a branch that
// has one — an implicit collision the daemon refuses, which can leave the workspace
// `stale`. The blocked line under the button says so rather than leaving a dead control.
//
// THE INCOMPATIBLE VERDICT OFFERS NOTHING TO PRESS THROUGH. It is a state, not a
// gate: the daemon will not bind that candidate under any acknowledgement, so the
// control closes and the sentence says what to do instead — a different branch, or
// retire the root first.
//
// IT IS COLLAPSED: preparing a root ahead of a run is deliberate and infrequent, and an
// open form on every workspace card would put four controls on a surface whose subject is
// what the session already holds.
//
// AND IT IS HELD BY THE SAME POSTURE THE MODE PICKER IS. A prepare IS a bind, so a
// mount that refuses every bind refuses this one, and the mode a prepare is read off is
// exactly what a pending switch is replacing — so the row derives one
// `workspaceControlPosture` and hands it to both controls. Held rather than withheld,
// on `mount-health.ts`'s own rule: the form stays where a person left it and the
// sentence says what is holding it, because a control that vanished would report a
// capability this workspace does not have rather than one that is momentarily closed.

import "./execution-roots.css";

import { useCallback } from "react";

import type { ExecutionMode } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { Nothing, WireFigure } from "@renderer/console/primitives/index.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { controlHoldSentence, type WorkspaceControlPosture } from "../mount-health.js";
import { usePrepareController } from "./hooks/usePrepareController.js";
import type { PrepareOperations, PrepareReading } from "./prepare-controller.js";
import {
  EMPTY_PREPARE_FORM,
  prepareAcknowledgement,
  prepareFormVerdict,
  prepareReuseStanding,
  reuseConsentRequired,
  REUSE_VERDICT_COPY,
  type PrepareFormState,
} from "./prepare-form.js";

/** What the prepare form is bound to: the workspace, its mode, and the calls it makes. */
export interface PrepareExecutionRootProps {
  readonly bridge: ConsoleBridge;
  /** The reuse check and the prepare this control sends. */
  readonly operations: PrepareOperations;
  readonly workspaceId: string;
  readonly repoMountId: string;
  /** The mode this workspace is bound in. */
  readonly executionMode: ExecutionMode;
  /** The session whose reconnect edge and repo frames re-ask the reuse question. */
  readonly sessionStore: SessionStore;
  /** Whether this workspace's binding controls are live. Derived once by the card. */
  readonly posture: WorkspaceControlPosture;
  /** Read the section again, so a prepared root appears in the roots list. */
  readonly onPrepared: () => void;
}

/** The collapsed form that puts an execution root on disk for one workspace. */
export function PrepareExecutionRoot(props: PrepareExecutionRootProps): React.JSX.Element {
  const { reading, controllerIdentity, checkReuse, prepare, clearAct } = usePrepareController(
    props.bridge,
    {
      workspaceId: props.workspaceId,
      repoMountId: props.repoMountId,
      executionMode: props.executionMode,
    },
    props.sessionStore,
    props.operations,
  );
  // THE FORM DIES WITH THE CONTROLLER IT IS BEING READ AGAINST. This row is keyed by
  // workspace id, so a mode switch re-mints the mode-scoped controller underneath a
  // component React never unmounts — and a plain register would carry the branch typed
  // under the old mode into a controller that has asked nothing about it. Addressed at
  // the controller's identity, so the pass that first sees the new one already reads an
  // empty form; an effect would clear it one committed frame later, and that frame has a
  // pressable control in it.
  const { value: form, publish: publishForm } = useSubjectScopedState<PrepareFormState>(
    controllerIdentity,
    undefined,
    () => EMPTY_PREPARE_FORM,
  );
  const standing = prepareReuseStanding(reading.prerequisite);
  const { verdict } = standing;
  const formVerdict = prepareFormVerdict(form, standing);
  const { onPrepared } = props;
  const heldBecause = controlHoldSentence(props.posture);

  const nameBranch = useCallback(
    (branchName: string) => {
      // THE CONSENT IS DROPPED WHENEVER THE BRANCH CHANGES, because it was given for a
      // specific candidate: carried across an edit it would consent to a different
      // tree's uncommitted work, which is the one mistake this control exists to make
      // impossible. Clearing the act with it keeps a stale settlement off a new intent.
      publishForm({ branchName, acknowledgedCandidateId: undefined });
      clearAct();
      checkReuse(branchName);
    },
    [checkReuse, clearAct, publishForm],
  );

  const submit = useCallback(() => {
    if (formVerdict.status !== "sendable") {
      return;
    }
    prepare(form.branchName, prepareAcknowledgement(form, verdict));
  }, [form, formVerdict, prepare, verdict]);

  return (
    <details className="meridian-prepare-root">
      <summary className="meridian-prepare-root__summary">
        Prepare an execution root
        <span className="meridian-prepare-root__line">{summaryLineFor(reading)}</span>
      </summary>

      <label className="meridian-prepare-root__branch">
        <span className="meridian-prepare-root__legend">Branch</span>
        <input
          type="text"
          className="meridian-prepare-root__branch-input"
          value={form.branchName}
          spellCheck={false}
          autoComplete="off"
          disabled={heldBecause !== undefined}
          onChange={(event) => {
            nameBranch(event.target.value);
          }}
        />
      </label>

      {renderReuse(reading)}

      {reuseConsentRequired(verdict) ? (
        <label className="meridian-prepare-root__consent">
          <input
            type="checkbox"
            disabled={heldBecause !== undefined}
            // THE BOX IS TICKED FOR A TREE AND NOT FOR A FORM. Both halves read the
            // candidate the verdict is naming NOW, so a refresh that serves a different
            // dirty checkout of the same branch draws the box unticked — the consent it
            // is asking for has not been given for that tree, and `prepareAcknowledgement`
            // is the same predicate the act sends on.
            checked={prepareAcknowledgement(form, verdict)}
            onChange={(event) => {
              publishForm((current) => ({
                ...current,
                acknowledgedCandidateId: event.target.checked ? verdict.worktreeId : undefined,
              }));
            }}
          />
          Reuse it with its uncommitted changes in place.
        </label>
      ) : null}

      {renderSettlement(reading, onPrepared)}

      <button
        type="button"
        className="meridian-prepare-root__confirm"
        disabled={
          heldBecause !== undefined ||
          formVerdict.status !== "sendable" ||
          reading.act.status === "sending"
        }
        onClick={submit}
      >
        Prepare
      </button>
      {heldBecause === undefined ? null : (
        // The mount's own sentence, or the selection act's — never a third wording for
        // a state two other surfaces are already reporting.
        <p className="meridian-prepare-root__held" role="status">
          {heldBecause}
        </p>
      )}
      {formVerdict.status === "incomplete" ? (
        <p className="meridian-prepare-root__blocked" role="status">
          {formVerdict.because}
        </p>
      ) : null}
    </details>
  );
}

/** One honest line per reading, for a summary with room for exactly one. */
function summaryLineFor(reading: PrepareReading): string {
  if (reading.act.status === "prepared") {
    return "prepared";
  }
  switch (reading.prerequisite.status) {
    case "not-read":
      return "name a branch";
    case "reading":
      return "checking for a live checkout";
    case "read":
      return reading.prerequisite.value.kind;
  }
}

/**
 * What the reuse check found, and the daemon's own reason where it gave one.
 *
 * The reason is rendered beside the console's sentence and never instead of it. The
 * console's sentence says what the verdict means for the act about to be sent; the daemon's
 * `reason` says what it found.
 */
function renderReuse(reading: PrepareReading): React.JSX.Element | null {
  switch (reading.prerequisite.status) {
    case "not-read":
      return <Nothing kind="not-checked" title="No branch named yet." />;
    case "reading":
      return <Nothing kind="computing" title="Checking for a live checkout." />;
    case "read": {
      const verdict = reading.prerequisite.value;
      return (
        <div
          className={`meridian-prepare-root__verdict meridian-prepare-root__verdict--${verdict.kind}`}
        >
          <p>{REUSE_VERDICT_COPY[verdict.kind]}</p>
          {verdict.kind === "none" ? null : (
            <p className="meridian-prepare-root__candidate">
              <WireFigure value={verdict.worktreeId} title={verdict.worktreeId} />
            </p>
          )}
          {verdict.kind === "dirty" || verdict.kind === "incompatible" ? (
            verdict.reason === undefined ? null : (
              <p className="meridian-prepare-root__reason">{verdict.reason}</p>
            )
          ) : null}
        </div>
      );
    }
  }
}

/** What the prepare did, with the section offered a re-read once it has. */
function renderSettlement(
  reading: PrepareReading,
  onPrepared: () => void,
): React.JSX.Element | null {
  switch (reading.act.status) {
    case "idle":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Preparing." />;
    case "prepared":
      return (
        <div className="meridian-prepare-root__prepared" role="status">
          <WireFigure value={reading.act.executionRoot} title={reading.act.executionRoot} />
          <span className="meridian-prepare-root__state">{reading.act.state}</span>
          {/*
            THE RE-READ IS A CONTROL, NOT AN EFFECT. A prepared root lands in the
            section's own roots list on its next read, and the user asking for
            that read is one of the three admitted refresh reasons — which is why
            the control stays after the first press rather than disappearing: the
            list can be asked again.
          */}
          <button type="button" className="meridian-prepare-root__reread" onClick={onPrepared}>
            Show it in the roots list
          </button>
        </div>
      );
  }
}
