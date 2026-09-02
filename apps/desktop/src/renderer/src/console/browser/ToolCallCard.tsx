// One page tool call, and the governance it is already under.
//
// `Spec-023 §Console Design (Meridian)` 12.7 says this surface renders "Nothing
// directly" — every invocation is an ordinary tool row in the timeline — and 12.8
// says approval cards render in the approvals surface "like any other, carrying
// category, the acting agent, and the action summary". Both are true, and this card
// is neither of them: it is the pane-side reading of a call the human is watching an
// agent make on the page in front of them, collapsed to one line with the arguments
// one click away (12.7's density rule, verbatim).
//
// WHAT IT DELIBERATELY DOES NOT DO.
//
//   • **It offers no approve and no reject.** 12.8: approval cards live in the
//     approvals surface, and "Nothing added to the approvals surface. Browser calls
//     are ordinary cards." A second pair of buttons here would be a second approval
//     path for one adjudication.
//
//   • **It derives no eligibility.** 12.8: "The console never derives whether a
//     browser tool call would be approved. Every call is dispatched, the daemon
//     adjudicates, and the typed refusal renders." So the outcome is an input, the
//     refusal renders verbatim, and the posture axis that refused is NAMED BY THE
//     DAEMON rather than guessed from a code.
//
// WHAT IT DOES STATE, because both are properties of the tool set by construction
// rather than readings of this call:
//
//   • the approval category — a browser tool call is a `tool_execution` approval
//     from the nine-member category set, and no new category is minted for it;
//   • the recovery floor — the session callback-tool row carries a name, a
//     description, and an input schema and NO idempotency class, and an undeclared
//     class is treated as `manual_reconcile_only`. Every browser tool therefore sits
//     at the recovery floor by construction, and the only path off that floor is
//     operator-governed class assignment scoped to a configured server binding,
//     which these tools have not got. The row says so, because "cannot be lifted" is
//     a stronger promise than "is not lifted" and a reader deserves the difference.

import { Chip, InlineRefusal, Nothing, WireFigure } from "../primitives/index.js";
import type { ConsoleRefusal } from "../core/index.js";

/**
 * The execution-posture axes a browser tool call can be refused on, named as 12.8
 * names them: "a posture-bound refusal names the axis (`networkAccess`,
 * `writableRoots`, or the mount envelope) that refused it".
 *
 * The first two are the posture's own field names and render mono for that reason;
 * the third is a boundary rather than a field, and renders as prose.
 */
export const BROWSER_POSTURE_AXES = ["networkAccess", "writableRoots", "mount-envelope"] as const;

export type BrowserPostureAxis = (typeof BROWSER_POSTURE_AXES)[number];

/** How each axis reads, and whether it wears the wire's provenance signature. */
const POSTURE_AXIS_LABELS: Readonly<
  Record<BrowserPostureAxis, { readonly label: string; readonly isWireName: boolean }>
> = {
  networkAccess: { label: "networkAccess", isWireName: true },
  writableRoots: { label: "writableRoots", isWireName: true },
  "mount-envelope": { label: "the mount envelope", isWireName: false },
};

/**
 * What the daemon did with this call. Never derived here — 12.8 dispatches every
 * call and renders what came back.
 */
export type BrowserToolCallOutcome =
  | { readonly status: "awaiting-adjudication" }
  | { readonly status: "answered"; readonly resultSummary: string }
  | {
      readonly status: "refused";
      readonly refusal: ConsoleRefusal;
      /** Which posture axis refused it, where one did. Absent for a Cedar denial. */
      readonly refusedAxis?: BrowserPostureAxis | undefined;
    };

/**
 * Whether a read-only claim was actually established.
 *
 * 12.7: `page.inspect` "rejects provable mutation at the engine where the engine can
 * prove it, and where it cannot, the result says so. A read-only claim that cannot
 * be checked is reported as unchecked rather than asserted." This is that report,
 * carried onto the row so the human sees the same distinction the agent got.
 */
export const BROWSER_READ_ONLY_EVIDENCE = ["engine-proved", "unchecked"] as const;

export type BrowserReadOnlyEvidence = (typeof BROWSER_READ_ONLY_EVIDENCE)[number];

export interface BrowserToolCallCardProps {
  /** The invocation id, wire-verbatim. */
  readonly toolCallId: string;
  /** The tool's registry name, wire-verbatim — never rewritten per driver. */
  readonly toolName: string;
  /** The arguments as the daemon carried them. Rendered only inside the disclosure. */
  readonly argumentsJson: string;
  /** The run that owns the page, by its label. Ownership is by run (12.7). */
  readonly owningRunLabel: string;
  readonly outcome: BrowserToolCallOutcome;
  /** Present only where the call made a read-only claim at all. */
  readonly readOnlyEvidence?: BrowserReadOnlyEvidence | undefined;
}

export function BrowserToolCallCard(props: BrowserToolCallCardProps): React.JSX.Element {
  const isRefused = props.outcome.status === "refused";
  const isWaiting = props.outcome.status === "awaiting-adjudication";
  const className = [
    "meridian-browser-card",
    isRefused ? "meridian-browser-card--refused" : "",
    isWaiting ? "meridian-browser-card--waiting" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");

  return (
    <article className={className} aria-label={`Page tool call ${props.toolName}`}>
      <div className="meridian-browser-card__head">
        <span className="meridian-browser-card__name">
          <WireFigure value={props.toolName} />
        </span>
        <div className="meridian-browser-card__meta">
          <Chip label={props.owningRunLabel} glyph="run" />
          {props.readOnlyEvidence === undefined ? null : (
            <Chip
              label={
                props.readOnlyEvidence === "engine-proved"
                  ? "Read-only, proved"
                  : "Read-only, unchecked"
              }
              tone={props.readOnlyEvidence === "unchecked" ? "attention" : "neutral"}
              glyph={props.readOnlyEvidence === "unchecked" ? "alert" : "check"}
            />
          )}
        </div>
      </div>

      {isWaiting ? (
        <Nothing
          kind="computing"
          placement="inline"
          title="With the daemon"
          detail="Dispatched and awaiting adjudication. The console does not predict the answer."
        />
      ) : null}

      {props.outcome.status === "answered" ? (
        <p className="meridian-browser-card__note">{props.outcome.resultSummary}</p>
      ) : null}

      {props.outcome.status === "refused" ? (
        <InlineRefusal
          code={props.outcome.refusal.code}
          detail={props.outcome.refusal.detail}
          action={
            props.outcome.refusedAxis === undefined ? undefined : (
              <span className="meridian-browser-card__note">
                Refused on{" "}
                {POSTURE_AXIS_LABELS[props.outcome.refusedAxis].isWireName ? (
                  <WireFigure value={POSTURE_AXIS_LABELS[props.outcome.refusedAxis].label} />
                ) : (
                  POSTURE_AXIS_LABELS[props.outcome.refusedAxis].label
                )}
                .
              </span>
            )
          }
        />
      ) : null}

      <details className="meridian-browser-disclosure">
        <summary>Arguments</summary>
        <pre className="meridian-browser-disclosure__body">{props.argumentsJson}</pre>
      </details>

      <p className="meridian-browser-governance">
        <WireFigure value="tool_execution" /> approval, adjudicated with every other tool. Recovery
        class <WireFigure value="manual_reconcile_only" />, which no surface on this node can lift —
        a call in flight at a daemon crash is reconciled by an operator, never replayed.
      </p>
    </article>
  );
}
