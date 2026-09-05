// One partition's clear control — the armed disclosure, and the act it runs.
//
// Split out of `BrowserSettingsPage.tsx` because the page is a PROJECTION and this is
// the one thing on it that is not: everything else there renders a figure it was
// handed, while this holds which step of a two-step act is in flight and what that act
// answered. Keeping it here is what lets the page stay renderable in a test, a
// screenshot tier, and an auxiliary window without a second code path.
//
// THE CONTROL IS PRESENT ON EVERY PARTITION, INCLUDING AN OPEN ONE. 13.16 gives every
// partition "a clear-site-data control per partition that closes the pane first", so
// an open pane is the case the control exists for. It takes the identity and the two
// acts rather than the partition record, which keeps the edge to the page running one
// way — the page imports this, and this imports nothing of the page's.
//
// WHAT IS RENDERED WHILE IT RUNS. The button says which step it is waiting on, because
// closing a pane and deleting a profile directory are different waits and a person
// watching an unchanged button cannot tell which one stalled. The region carries
// `aria-busy` for the same reason, and the button is disabled so a second confirm
// cannot start a second close underneath the first.
//
// THE ROUND IS NOT THIS COMPONENT'S. The table folds past a threshold, so a listing
// that refreshes mid-clear can move this row between two lists and React remounts it
// — which used to bring the control back idle in the middle of its own act. What it
// is doing and whether another may start both live on the page's
// `PartitionClearRounds`, and this file renders that reading and dispatches into it.
//
// WHICH VERDICT IS SHOWN, AND WHY IT IS RANKED RATHER THAN COALESCED. The control holds
// two facts that can both be present: the projected refusal of a clear that failed out
// of band, and the outcome of the act the operator ran here. Preferring "whichever
// refusal exists" reports failure after a clear that WORKED, because a served
// settlement carries no refusal to prefer. So the two are ranked instead: an outcome
// settled in this mount is the operator's own act and outranks the projection whichever
// way it went, and the projection speaks only while this control has settled nothing.
// A served settlement gets a reading of its own, because a receipt that renders as the
// absence of a complaint is indistinguishable from an act that never ran.

import { useCallback, useSyncExternalStore } from "react";

import { normalizeWireRejection, type ConsoleRefusal } from "../core/index.js";
import { Chip, InlineRefusal, Nothing } from "../primitives/index.js";
import type { PartitionClearRounds, PartitionClearState } from "./partition-clear-rounds.js";
import {
  closeThenClearSiteData,
  type ClearSiteDataStep,
  type SiteDataAct,
} from "./site-data-clear.js";

/** The subsystem name a failure raised by this control itself carries. */
const CLEAR_CONTROL_REFUSAL_ORIGIN = "browser-settings";

/**
 * What the confirm says while it waits. Declared once beside the state it reads, and
 * keyed by the step union so a new step cannot be added without a sentence for it.
 */
const RUNNING_LABELS: Record<ClearSiteDataStep, string> = {
  "closing-pane": "Closing the pane…",
  clearing: "Clearing…",
};

/**
 * What the control reports beneath the arm, once the two facts it holds are ranked.
 *
 * Three arms rather than "a refusal or nothing": a served settlement is a fact to
 * render and not an absence of one, and giving it an arm is what stops the projected
 * refusal from reappearing under a clear that succeeded.
 */
type ClearControlReport =
  | { readonly kind: "cleared" }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal }
  | { readonly kind: "silent" };

/**
 * The ranking, as a pure reading of the control's own state and what it was handed.
 *
 * `running` reports nothing on purpose. An act is in flight, the button already says
 * which step it is waiting on, and the projection it is about to replace is the one
 * verdict on screen that is certainly not about this attempt.
 */
function reportFor(
  state: PartitionClearState,
  lastClearRefusal: ConsoleRefusal | undefined,
): ClearControlReport {
  if (state.phase === "settled") {
    return state.outcome.status === "cleared"
      ? { kind: "cleared" }
      : { kind: "refused", refusal: state.outcome.refusal };
  }
  if (state.phase === "running" || lastClearRefusal === undefined) {
    return { kind: "silent" };
  }
  return { kind: "refused", refusal: lastClearRefusal };
}

export interface PartitionClearControlProps {
  readonly sessionId: string;
  /**
   * The page's own record of which partitions have a clear running.
   *
   * Handed in rather than held here, because a row is remounted by an ordinary
   * refresh and an act it started has to survive that.
   */
  readonly rounds: PartitionClearRounds;
  /** The daemon's reading of whether a pane still holds the partition open. */
  readonly hasOpenPane: boolean;
  /** A clear that failed out of band, projected by whoever owns the listing. */
  readonly lastClearRefusal: ConsoleRefusal | undefined;
  /** Absent while no close verb is registered on this build. */
  readonly onClosePane: SiteDataAct | undefined;
  /** Absent while no site-data reset is registered on this build. */
  readonly onClearSiteData: SiteDataAct | undefined;
}

export function PartitionClearControl(props: PartitionClearControlProps): React.JSX.Element {
  const { hasOpenPane, lastClearRefusal, onClearSiteData, onClosePane, rounds, sessionId } = props;
  const subscribe = useCallback((onChange: () => void) => rounds.subscribe(onChange), [rounds]);
  const read = useCallback(() => rounds.stateFor(sessionId), [rounds, sessionId]);
  // `useSyncExternalStore` rather than a `useState` an effect copies into, for the
  // reason the substrate's own holders take it: a step recorded between this render
  // and a subscription installed in an effect is missed, and a missed step is a button
  // that goes on naming the wrong wait.
  const state = useSyncExternalStore(subscribe, read, read);

  const confirm = useCallback((): void => {
    if (onClearSiteData === undefined) {
      return;
    }
    // Which step a REJECTED act died on, rather than a guess made at the catch site:
    // "the pane would not close" and "the directory would not go" send a person to
    // two different places.
    let reachedStep: ClearSiteDataStep = hasOpenPane ? "closing-pane" : "clearing";
    const round = rounds.begin(sessionId, reachedStep);
    if (round === undefined) {
      // A clear is already running on this partition. The button is disabled for
      // exactly that lifetime, so there is nothing to start and nothing new to say —
      // and this is the arm a control remounted mid-clear reaches.
      return;
    }
    void closeThenClearSiteData({
      sessionId,
      hasOpenPane,
      closePane: onClosePane,
      clearSiteData: onClearSiteData,
      onStep: (step) => {
        reachedStep = step;
        rounds.reachStep(round, sessionId, step);
      },
    }).then(
      (outcome) => {
        rounds.settle(round, sessionId, outcome);
      },
      (failure: unknown) => {
        rounds.settle(round, sessionId, {
          status: "refused",
          at: reachedStep,
          refusal: normalizeWireRejection(CLEAR_CONTROL_REFUSAL_ORIGIN, failure, {
            code: "site-data-act-failed",
            detail:
              "The node stopped answering during this step, so how far it got is not known from here. Re-reading the site-data list is what says where this partition ended up.",
          }),
        });
      },
    );
  }, [hasOpenPane, onClearSiteData, onClosePane, rounds, sessionId]);

  const report = reportFor(state, lastClearRefusal);

  return (
    <div className="meridian-browser-partitions__control" aria-busy={state.phase === "running"}>
      {hasOpenPane ? (
        <Chip tone="attention" glyph="alert" label="A pane still has this partition open" />
      ) : null}
      <details className="meridian-browser-arm">
        <summary>Clear site data</summary>
        <div className="meridian-browser-arm__body">
          <p className="meridian-browser-arm__scope">
            Removes every cookie, cache entry, and storage record this session&rsquo;s browser panes
            wrote, and deletes the profile directory holding them. It reaches nothing outside this
            session, and it is a filesystem removal rather than a cryptographic erase.
          </p>
          {hasOpenPane ? (
            <p className="meridian-browser-arm__scope">
              A browser pane in this session still has the partition open. Confirming closes that
              pane first, and clears only once it has closed.
            </p>
          ) : null}
          {onClearSiteData === undefined ? (
            <Nothing
              kind="not-checked"
              placement="inline"
              title="No writer registered"
              detail="This node exposes no site-data reset yet, so there is nothing to confirm."
            />
          ) : (
            <button
              type="button"
              className="meridian-browser-action"
              disabled={state.phase === "running"}
              onClick={confirm}
            >
              {state.phase === "running"
                ? RUNNING_LABELS[state.step]
                : "Clear this session’s site data"}
            </button>
          )}
        </div>
      </details>
      {report.kind === "cleared" ? (
        <p className="meridian-browser-partitions__reading" role="status">
          Cleared. The node reports this session&rsquo;s site data removed.
        </p>
      ) : null}
      {report.kind === "refused" ? (
        <InlineRefusal code={report.refusal.code} detail={report.refusal.detail} />
      ) : null}
    </div>
  );
}
