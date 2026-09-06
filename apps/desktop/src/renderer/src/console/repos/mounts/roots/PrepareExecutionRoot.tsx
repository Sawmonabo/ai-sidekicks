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
// for the case that has none.
//
// THE INCOMPATIBLE VERDICT OFFERS NOTHING TO PRESS THROUGH. It is a state, not a
// gate: the daemon will not bind that candidate under any acknowledgement, so the
// control closes and the sentence says what to do instead — a different branch, or
// retire the root first.
//
// IT IS COLLAPSED, on the gate disclosure's posture: preparing a root ahead of a run is
// deliberate and infrequent, and an open form on every workspace card would put four
// controls on a surface whose subject is what the session already holds.

import { useCallback, useState } from "react";

import type { ExecutionMode } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { InlineRefusal, Nothing, WireFigure } from "../../../primitives/index.js";
import type { SessionStore } from "../../../store/index.js";
import { mountRefusalRecovery } from "../mount-refusal-copy.js";
import { RefusalRecovery } from "../RefusalRecovery.js";
import { usePrepareController } from "./prepare-binding.js";
import type { PrepareReading } from "./prepare-controller.js";
import {
  EMPTY_PREPARE_FORM,
  prepareFormVerdict,
  reuseConsentRequired,
  REUSE_VERDICT_COPY,
  type PrepareFormState,
  type ReuseVerdict,
} from "./root-act-model.js";

/** The mode whose root is a clone rather than a worktree. */
const CLONE_EXECUTION_MODE = "ephemeral clone" satisfies ExecutionMode;

/** The one non-writable mode, which materialises no execution root at all. */
const READ_ONLY_EXECUTION_MODE = "read-only" satisfies ExecutionMode;

export interface PrepareExecutionRootProps {
  readonly bridge: ConsoleBridge;
  readonly workspaceId: string;
  readonly repoMountId: string;
  /** The mode this workspace is bound in. Decides which call the confirm sends. */
  readonly executionMode: ExecutionMode;
  /** The session whose reconnect edge and repo frames re-ask the reuse question. */
  readonly sessionStore: SessionStore;
  /** Read the section again, so a prepared root appears in the roots list. */
  readonly onPrepared: () => void;
}

export function PrepareExecutionRoot(props: PrepareExecutionRootProps): React.JSX.Element | null {
  const isClone = props.executionMode === CLONE_EXECUTION_MODE;
  const { reading, checkReuse, prepare, prepareClone, clearAct } = usePrepareController(
    props.bridge,
    {
      workspaceId: props.workspaceId,
      repoMountId: props.repoMountId,
      executionMode: props.executionMode,
    },
    props.sessionStore,
  );
  const [form, setForm] = useState<PrepareFormState>(EMPTY_PREPARE_FORM);
  const verdict = reuseVerdictOf(reading);
  const formVerdict = prepareFormVerdict(form, verdict);
  const { onPrepared } = props;

  const nameBranch = useCallback(
    (branchName: string) => {
      // THE CONSENT IS DROPPED WHENEVER THE BRANCH CHANGES, because it was given for a
      // specific candidate: carried across an edit it would consent to a different
      // tree's uncommitted work, which is the one mistake this control exists to make
      // impossible. Clearing the act with it keeps a stale settlement off a new intent.
      setForm({ branchName, acknowledgeDirtyCandidate: false });
      clearAct();
      // A CLONE ASKS NO REUSE QUESTION. Clones are minted per run and nothing is
      // reused, so a check here would put a call on the wire whose answer no control
      // below reads.
      if (!isClone) {
        checkReuse(branchName);
      }
    },
    [checkReuse, clearAct, isClone],
  );

  const submit = useCallback(() => {
    if (formVerdict.status !== "sendable") {
      return;
    }
    if (isClone) {
      prepareClone(form.branchName);
      return;
    }
    prepare(form.branchName, form.acknowledgeDirtyCandidate);
  }, [form, formVerdict, isClone, prepare, prepareClone]);

  if (props.executionMode === READ_ONLY_EXECUTION_MODE) {
    // NOTHING AT ALL, AND NOT A CLOSED CONTROL. A read-only workspace materialises no
    // execution root, so there is no act here that could be offered or refused — and a
    // greyed control would report a capability this mode does not have as one it is
    // merely being denied.
    return null;
  }

  return (
    <details className="meridian-prepare-root">
      <summary className="meridian-prepare-root__summary">
        Prepare an execution root
        <span className="meridian-prepare-root__line">{summaryLineFor(reading, isClone)}</span>
      </summary>

      <label className="meridian-prepare-root__branch">
        <span className="meridian-prepare-root__legend">Branch</span>
        <input
          type="text"
          className="meridian-prepare-root__branch-input"
          value={form.branchName}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            nameBranch(event.target.value);
          }}
        />
      </label>

      {isClone ? null : renderReuse(reading)}

      {reuseConsentRequired(verdict) ? (
        <label className="meridian-prepare-root__consent">
          <input
            type="checkbox"
            checked={form.acknowledgeDirtyCandidate}
            onChange={(event) => {
              setForm((current) => ({
                ...current,
                acknowledgeDirtyCandidate: event.target.checked,
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
        disabled={formVerdict.status !== "sendable" || reading.act.status === "sending"}
        onClick={submit}
      >
        {isClone ? "Prepare a clone" : "Prepare"}
      </button>
      {formVerdict.status === "incomplete" ? (
        <p className="meridian-prepare-root__blocked" role="status">
          {formVerdict.because}
        </p>
      ) : null}
    </details>
  );
}

/**
 * The verdict the form is being read against.
 *
 * A CHECK THAT HAS NOT ANSWERED IS `none`, NOT A REFUSAL TO PROCEED. The prepare is
 * legal with no candidate and the wire decides in any case; treating an unanswered
 * check as a blocker would close the control on a question still in flight, and
 * treating it as consent-requiring would ask for a consent about nothing.
 */
function reuseVerdictOf(reading: PrepareReading): ReuseVerdict {
  return reading.prerequisite.status === "read" ? reading.prerequisite.value : { kind: "none" };
}

/** One honest line per reading, for a summary with room for exactly one. */
function summaryLineFor(reading: PrepareReading, isClone: boolean): string {
  if (reading.act.status === "prepared") {
    return "prepared";
  }
  if (isClone) {
    return "a clone per run";
  }
  switch (reading.prerequisite.status) {
    case "not-read":
      return "name a branch";
    case "reading":
      return "checking for a live checkout";
    case "refused":
      return `reuse not checked — ${reading.prerequisite.refusal.code}`;
    case "read":
      return reading.prerequisite.value.kind;
  }
}

/**
 * What the reuse check found, and the daemon's own reason where it gave one.
 *
 * THE REASON IS RENDERED BESIDE THE CONSOLE'S SENTENCE AND NEVER INSTEAD OF IT. The
 * console's sentence says what the verdict MEANS for the act about to be sent; the
 * daemon's `reason` says what it found. Substituting one for the other would leave a
 * person reading a git fact with no statement of what it costs them.
 */
function renderReuse(reading: PrepareReading): React.JSX.Element {
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
          action={renderRecovery(reading.prerequisite.refusal.code)}
        />
      );
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

/** What the prepare did, with the section asked to re-read on the served arm. */
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
      return (
        <InlineRefusal
          code={reading.act.refusal.code}
          detail={reading.act.refusal.detail}
          action={renderRecovery(reading.act.refusal.code)}
        />
      );
    case "prepared":
      return (
        <div className="meridian-prepare-root__prepared" role="status">
          <WireFigure value={reading.act.executionRoot} title={reading.act.executionRoot} />
          <span className="meridian-prepare-root__state">{reading.act.state}</span>
          {/*
            THE RE-READ IS A CONTROL, NOT AN EFFECT. A prepared root lands in the
            section's own roots list on its next read, and the participant asking for
            that read is one of the three refresh reasons `Spec-023 §Rules every console
            surface obeys` admits. A `provisioning` root also has a second state to
            reach, and this is what asks about it — which is why the control stays after
            the first press rather than disappearing.
          */}
          <button type="button" className="meridian-prepare-root__reread" onClick={onPrepared}>
            Show it in the roots list
          </button>
        </div>
      );
  }
}

/** This family's recovery for a code that has one, in the refusal shape's own slot. */
function renderRecovery(code: string): React.JSX.Element | undefined {
  const recovery = mountRefusalRecovery(code);
  return recovery === undefined ? undefined : <RefusalRecovery recovery={recovery} />;
}
