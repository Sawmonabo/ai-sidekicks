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

import { useCallback, useState } from "react";

import { ConsoleRefusalError, refuse, type ConsoleRefusal } from "../core/index.js";
import { Chip, InlineRefusal, Nothing } from "../primitives/index.js";
import {
  closeThenClearSiteData,
  type ClearSiteDataOutcome,
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

/** The control's three phases. One closed set, declared here and derived nowhere else. */
type ClearControlState =
  | { readonly phase: "idle" }
  | { readonly phase: "running"; readonly step: ClearSiteDataStep }
  | { readonly phase: "settled"; readonly outcome: ClearSiteDataOutcome };

export interface PartitionClearControlProps {
  readonly sessionId: string;
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
  const { hasOpenPane, lastClearRefusal, onClearSiteData, onClosePane, sessionId } = props;
  const [state, setState] = useState<ClearControlState>({ phase: "idle" });

  const confirm = useCallback((): void => {
    if (onClearSiteData === undefined) {
      return;
    }
    // Which step a REJECTED act died on, rather than a guess made at the catch site:
    // "the pane would not close" and "the directory would not go" send a person to
    // two different places.
    let reachedStep: ClearSiteDataStep = hasOpenPane ? "closing-pane" : "clearing";
    void closeThenClearSiteData({
      sessionId,
      hasOpenPane,
      closePane: onClosePane,
      clearSiteData: onClearSiteData,
      onStep: (step) => {
        reachedStep = step;
        setState({ phase: "running", step });
      },
    }).then(
      (outcome) => {
        setState({ phase: "settled", outcome });
      },
      (failure: unknown) => {
        setState({
          phase: "settled",
          outcome: {
            status: "refused",
            at: reachedStep,
            refusal:
              failure instanceof ConsoleRefusalError
                ? failure.refusal
                : refuse(
                    CLEAR_CONTROL_REFUSAL_ORIGIN,
                    "site-data-act-failed",
                    "The node stopped answering during this step, so how far it got is not known from here. Re-reading the site-data list is what says where this partition ended up.",
                  ),
          },
        });
      },
    );
  }, [hasOpenPane, onClearSiteData, onClosePane, sessionId]);

  const settledRefusal =
    state.phase === "settled" && state.outcome.status === "refused"
      ? state.outcome.refusal
      : undefined;
  // The act the operator just took wins over the projected one: it is the newer fact
  // and the one they are standing here waiting for.
  const shownRefusal = settledRefusal ?? lastClearRefusal;

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
      {shownRefusal === undefined ? null : (
        <InlineRefusal code={shownRefusal.code} detail={shownRefusal.detail} />
      )}
    </div>
  );
}
