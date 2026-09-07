import type { ReactNode } from "react";

import {
  Chip,
  DerivedFigure,
  Nothing,
  WireFigure,
  formatDateTime,
  formatDuration,
  formatPercent,
} from "../../../../primitives/index.js";
import { MILLISECONDS_PER_MINUTE, UTILIZATION_BAR_FULL_SCALE } from "../../../../core/index.js";
import type { AccountQuotaRow } from "./quota-rows.js";

/**
 * One account's per-limit quota table, one row per limit the provider publishes.
 *
 * KEYED BY LIMIT AND NEVER BY WINDOW LENGTH. Three of a pinned provider's limits share
 * one 10080-minute window, so the limit identifier is the row's identity and the window
 * length is an attribute of the reading — which is why both are columns and only one is
 * the key.
 *
 * THE PERCENTAGE IS CLAMPED FOR DISPLAY AND THE WIRE FIGURE IS NOT. A provider may
 * report over-consumption against a soft limit, so the bar stops at full while the
 * figure beside it says what was actually reported. Clamping the number too would
 * silently misreport it.
 *
 * A READING TAKEN UNDER AN OLDER CREDENTIAL GENERATION SAYS SO. A credential-home
 * rebuild does not clear stored readings — the provider-side allowance keeps running
 * while the home is empty — so such a row is true about the provider and behind this
 * account, and a table that hid the difference would show a fresh account as nearly
 * spent.
 */
export function QuotaTable(props: { readonly rows: readonly AccountQuotaRow[] }): ReactNode {
  if (props.rows.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="No quota reading has been stored for this account."
        detail="A reading is recorded when a run spends against the account or when a probe asks for one."
      />
    );
  }
  return (
    <table className="meridian-accounts__quota">
      <thead>
        <tr>
          <th scope="col">Limit</th>
          <th scope="col">Window</th>
          <th scope="col">Used</th>
          <th scope="col">Resets</th>
          <th scope="col">Observed</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map(({ window, behindAccountGeneration }) => (
          <tr key={window.limitId}>
            <th scope="row">
              {window.label === undefined ? (
                <WireFigure value={window.limitId} />
              ) : (
                <>
                  <span>{window.label}</span> <WireFigure value={window.limitId} />
                </>
              )}
            </th>
            <td>
              <DerivedFigure text={formatDuration(window.windowMins * MILLISECONDS_PER_MINUTE)} />
            </td>
            <td>
              <progress
                className="meridian-accounts__quota-bar"
                max={UTILIZATION_BAR_FULL_SCALE}
                value={Math.min(window.usedPercent / 100, UTILIZATION_BAR_FULL_SCALE)}
              />
              <DerivedFigure text={formatPercent(window.usedPercent / 100)} />
            </td>
            <td>
              {window.resetsAt === undefined ? (
                <span className="meridian-settings-page__aside">Not published</span>
              ) : (
                <DerivedFigure text={formatDateTime(window.resetsAt)} />
              )}
            </td>
            <td>
              <DerivedFigure text={formatDateTime(window.observedAt)} />{" "}
              <Chip label={window.source} mono />
              {behindAccountGeneration ? (
                <Chip label="Behind this account’s credential" tone="attention" glyph="alert" />
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
