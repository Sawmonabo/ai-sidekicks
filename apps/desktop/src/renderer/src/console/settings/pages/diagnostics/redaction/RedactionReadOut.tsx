// The redaction read-out: what this machine keeps, for how long, and where it may go.
//
// `Spec-023 §Console Design (Meridian)` §Diagnostics and health: "The redaction policy
// read-out from `health.redactionPolicyRead`: the four diagnostic buckets, the
// default-deny outbound posture, and a prominent notice when a retention override is
// active."
//
// IT REPORTS AND CHANGES NOTHING. The same section forbids this page from offering an
// outbound send or altering a policy, so there is no control anywhere in this
// component — not a toggle, not a link, not a disabled one. What a person can do about
// a retention override is not this surface's answer to give.
//
// THE ROWS ARE THE REPLY'S AND THE ORDER IS TOO. The buckets are rendered as the node
// listed them rather than sorted into the console's own order, because the reply is a
// statement of policy and re-ordering a statement is editing it. A bucket the node did
// not mention is simply not a row: this component adds no default row for a bucket
// that was omitted, which would be the console composing policy.
//
// THE RAW-CONTENT OPT-IN IS THE INTERESTING COLUMN and is stated in both directions.
// "Raw content kept" and "redacted" are different facts and a blank cell is neither,
// so every row says which of the two it is.

import type { ReactNode } from "react";

import {
  Chip,
  DerivedFigure,
  Nothing,
  WireFigure,
  formatCount,
} from "../../../../primitives/index.js";
import type { GrowthRedactionPolicy } from "../../../../bridge/index.js";
import { REDACTION_BUCKET_DESCRIPTIONS } from "../health-vocabulary.js";

export function RedactionReadOut(props: { readonly policy: GrowthRedactionPolicy }): ReactNode {
  const { policy } = props;
  return (
    <div className="meridian-redaction">
      {policy.retentionPolicyOverrideActive ? (
        <p className="meridian-redaction__override" role="status">
          <Chip tone="attention" label="Retention override in force" glyph="alert" />
          <span>
            A retention override is active on this machine, so the durations below are not this
            release&rsquo;s defaults. This page reports the override and does not change it.
          </span>
        </p>
      ) : null}
      <p className="meridian-redaction__outbound">
        Outbound: <WireFigure value={policy.outboundDefault} />. Diagnostics stay on this machine
        unless somebody deliberately exports them, and there is no control here that would send any
        of it anywhere.
      </p>
      {policy.buckets.length === 0 ? (
        <Nothing
          kind="empty"
          placement="inline"
          title="This machine named no diagnostic buckets."
          detail="The read succeeded and listed nothing. No default rows are drawn in their place, because a retention figure this console composed would be a policy nobody is bound by."
        />
      ) : (
        <table className="meridian-redaction__table">
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              <th scope="col">Kept for</th>
              <th scope="col">Content</th>
            </tr>
          </thead>
          <tbody>
            {policy.buckets.map((bucket) => (
              <tr key={bucket.bucket}>
                <th scope="row">
                  <WireFigure value={bucket.bucket} />
                  <span className="meridian-redaction__what">
                    {REDACTION_BUCKET_DESCRIPTIONS[bucket.bucket]}
                  </span>
                </th>
                <td>
                  <DerivedFigure text={`${formatCount(bucket.ttlDays)} days`} />
                </td>
                <td>{bucket.rawContentOptIn ? "Raw content kept" : "Redacted"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
