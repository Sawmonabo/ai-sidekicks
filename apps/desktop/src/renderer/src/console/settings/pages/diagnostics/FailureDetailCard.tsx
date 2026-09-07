// The failure card: what actually failed, by class rather than as one generic error.
//
// `Spec-023 §Console Design (Meridian)` §Diagnostics and health: "a failure-detail card
// from `health.failureDetailRead` that distinguishes the failure classes rather than
// reporting one generic error."
//
// SO THE CLASS IS THE HEADLINE AND IS RENDERED VERBATIM. `failureCategory` is a closed
// four-member wire vocabulary (`RunFailureCategory`), and it is rendered as the node
// spelled it anyway — not for want of a table, but because the members ARE the prose:
// "provider failure", "transport failure", "local persistence failure", "projection
// failure". A lookup here would map four English phrases onto four English phrases and
// take on a total-record obligation for the privilege, while putting a second spelling
// of the wire's own words on screen. It goes in mono beside the node's own summary
// sentence, which is the distinction the design asks for.
//
// THE TECHNICAL DETAIL IS A DISCLOSURE, NOT A DUMP. The density rule puts failure
// detail "one disclosure away", so the structured payload sits behind a `<details>`
// rather than expanding the page for every reader. It is rendered as its own JSON
// through the console's one stringifier: this card knows nothing about which keys a
// category carries, and inventing a row per key would be this surface claiming a
// schema the wire does not publish.
//
// AND IT IS NEVER PARTIALLY MASKED. The section's own rule — "never partially masks
// diagnostic content, because partial redaction of personal data is not redaction" —
// means this card either shows the payload the node sent or shows none of it. There is
// no eliding, no truncation with an ellipsis, and no per-key filter.

import type { ReactNode } from "react";

import { DerivedFigure, WireFigure, formatDateTime } from "../../../primitives/index.js";
import { lossyStringify } from "../../../core/index.js";
import type { GrowthFailureDetail } from "../../../bridge/index.js";

export function FailureDetailCard(props: { readonly detail: GrowthFailureDetail }): ReactNode {
  const { detail } = props;
  return (
    <div className="meridian-failure-card">
      <p className="meridian-failure-card__class">
        <WireFigure value={detail.failureCategory} />
        <span className="meridian-failure-card__when">
          <DerivedFigure text={formatDateTime(detail.occurredAt)} />
        </span>
      </p>
      <p className="meridian-failure-card__summary">{detail.humanSummary}</p>
      <dl className="meridian-failure-card__axes">
        <dt>Run</dt>
        <dd>
          <WireFigure value={detail.runId} />
        </dd>
        {detail.recoveryCondition === undefined ? null : (
          <>
            <dt>Recovery condition</dt>
            <dd>
              <WireFigure value={detail.recoveryCondition} />
            </dd>
          </>
        )}
        {detail.recoverySpanClassification === undefined ? null : (
          <>
            <dt>Recovery span</dt>
            <dd>
              <WireFigure value={detail.recoverySpanClassification} />
            </dd>
          </>
        )}
      </dl>
      <details className="meridian-failure-card__technical">
        <summary>What the node sent with it</summary>
        <pre className="meridian-failure-card__payload">
          {lossyStringify(detail.technicalDetails)}
        </pre>
      </details>
    </div>
  );
}
