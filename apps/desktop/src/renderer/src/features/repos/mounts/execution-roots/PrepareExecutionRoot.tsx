// Puts an execution root on disk for one workspace ahead of any run. The reuse check is the
// form: the verdict for the named branch (create, reuse, reuse needing consent, or refusal) is
// drawn under the field, and the control follows it, shut while the check is in flight. The
// consent box exists only for the dirty verdict and records the candidate's id, so it belongs to
// one tree. The incompatible verdict closes the control. The form is collapsed and held by the
// same availability as the mode picker, since a prepare is a bind; held, not withheld, so the
// sentence says what is holding it.

import "./execution-roots.css";

import { useCallback } from "react";

import type { ExecutionMode } from "@ai-sidekicks/contracts/repo";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { controlHoldSentence, type WorkspaceControlAvailability } from "../mount-health.js";
import { usePrepareController } from "./hooks/usePrepareController.js";
import type { PrepareOperations, PrepareReading } from "./prepare-controller.js";
import {
  EMPTY_PREPARE_FORM,
  isDirtyReuseAcknowledged,
  resolvePrepareForm,
  readReuseCheckState,
  reuseConsentRequired,
  REUSE_VERDICT_COPY,
  type PrepareFormState,
} from "./prepare-form.js";

/** What the prepare form is bound to: the workspace, its mode, and the calls it makes. */
export interface PrepareExecutionRootProps {
  readonly bridge: PlatformBridge;
  /** The reuse check and the prepare this control sends. */
  readonly operations: PrepareOperations;
  readonly workspaceId: string;
  readonly repoMountId: string;
  /** The mode this workspace is bound in. */
  readonly executionMode: ExecutionMode;
  /** The session whose reconnect edge and repo frames re-ask the reuse question. */
  readonly sessionStore: SessionStore;
  /** Whether this workspace's binding controls are live. Derived once by the card. */
  readonly availability: WorkspaceControlAvailability;
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
  // The form dies with the controller it is read against: a mode switch re-mints the
  // mode-scoped controller under a component React never unmounts, and a plain register would
  // carry the old branch across. Addressing state at the controller's identity re-seeds it in
  // the same pass; an effect would leave one committed frame with a pressable control.
  const { value: form, publish: publishForm } = useSubjectScopedState<PrepareFormState>(
    controllerIdentity,
    undefined,
    () => EMPTY_PREPARE_FORM,
  );
  const standing = readReuseCheckState(reading.prerequisite);
  const { verdict } = standing;
  const formVerdict = resolvePrepareForm(form, standing);
  const { onPrepared } = props;
  const unavailableBecause = controlHoldSentence(props.availability);

  const nameBranch = useCallback(
    (branchName: string) => {
      // The consent is dropped whenever the branch changes: it was given for one candidate and
      // would otherwise consent to another tree's uncommitted work. Clearing the act keeps a
      // stale settlement off the new intent.
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
    prepare(form.branchName, isDirtyReuseAcknowledged(form, verdict));
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
          disabled={unavailableBecause !== undefined}
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
            disabled={unavailableBecause !== undefined}
            // Ticked for a tree, not a form: both halves read the candidate the verdict names
            // now, so a refresh serving a different dirty checkout draws the box unticked.
            checked={isDirtyReuseAcknowledged(form, verdict)}
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
          unavailableBecause !== undefined ||
          formVerdict.status !== "sendable" ||
          reading.act.status === "sending"
        }
        onClick={submit}
      >
        Prepare
      </button>
      {unavailableBecause === undefined ? null : (
        // The mount's own sentence, or the selection act's; never a third wording.
        <p className="meridian-prepare-root__held" role="status">
          {unavailableBecause}
        </p>
      )}
      {/* A refused check draws its refusal above, which an unanswered line would contradict. */}
      {formVerdict.status === "incomplete" && reading.prerequisite.status !== "refused" ? (
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
    case "refused":
      return reading.prerequisite.refusal.detail;
    case "read":
      return reading.prerequisite.value.kind;
  }
}

/**
 * What the reuse check found, and the daemon's own reason where it gave one. The reason is
 * rendered beside the console's sentence, which says what the verdict means for the act.
 */
function renderReuse(reading: PrepareReading): React.JSX.Element | null {
  switch (reading.prerequisite.status) {
    case "not-read":
      return <Nothing kind="not-checked" title="No branch named yet." />;
    case "reading":
      return <Nothing kind="computing" title="Checking for a live checkout." />;
    case "refused":
      return (
        <InlineRefusal
          code={reading.prerequisite.refusal.code}
          detail={reading.prerequisite.refusal.detail}
        />
      );
    case "read": {
      const verdict = reading.prerequisite.value;
      return (
        <div
          className={
            "meridian-prepare-root__verdict " + `meridian-prepare-root__verdict--${verdict.kind}`
          }
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
    case "refused":
      return <InlineRefusal code={reading.act.refusal.code} detail={reading.act.refusal.detail} />;
    case "prepared":
      return (
        <div className="meridian-prepare-root__prepared" role="status">
          <WireFigure value={reading.act.executionRoot} title={reading.act.executionRoot} />
          <span className="meridian-prepare-root__state">{reading.act.state}</span>
          {/* The re-read is a control, not an effect: it stays after the first press because the
              list can be asked again. */}
          <button type="button" className="meridian-prepare-root__reread" onClick={onPrepared}>
            Show it in the roots list
          </button>
        </div>
      );
  }
}
