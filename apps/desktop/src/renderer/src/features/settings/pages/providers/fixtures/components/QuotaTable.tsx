import type { ReactNode } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { codeWords } from "#renderer/lib/code-words.js";
import {
  formatExactPercent,
  formatDateTime,
  formatDuration,
  formatWholeDuration,
  formatPercent,
  formatZonedDateTime,
} from "#renderer/lib/wire/figures.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { MILLISECONDS_PER_MINUTE } from "#renderer/lib/instant.js";
import type { AccountQuotaRow } from "../quota-rows.js";

/**
 * The full-scale value a utilization bar is drawn against, and the clamp on its fill.
 *
 * A reading can exceed its limit and an over-full `<progress>` renders differently across
 * engines, so the bar is clamped and the figure beside it is not: the bar answers "how full",
 * which saturates, and the percentage answers "how much". One, because `Intl` takes a fraction.
 */
const UTILIZATION_BAR_FULL_SCALE = 1;

/**
 * One account's per-limit quota table, one row per limit the provider publishes.
 *
 * Keyed by limit, never by window length: three of a pinned provider's limits share one
 * 10080-minute window. The limit identifier is a wire spelling and is never drawn; a row is
 * named by the provider's label, or by its window length where none was published. The
 * percentage is clamped for display and the wire figure is not, so over-consumption against a
 * soft limit is still reported. A reading taken under an older credential generation says so:
 * a credential-home rebuild does not clear stored readings, so such a row is true about the
 * provider and behind this account.
 */
export function QuotaTable(props: { readonly rows: readonly AccountQuotaRow[] }): ReactNode {
  const clockLocale = useClockLocale();
  if (props.rows.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="No quota reading has been stored for this account."
        detail={
          "A reading is recorded when a run spends against the account or " +
          "when a probe asks for one."
        }
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
            <th scope="row">{window.label ?? <WindowLength window={window} />}</th>
            <td>
              <WindowLength window={window} />
            </td>
            <td>
              <progress
                className="meridian-accounts__quota-bar"
                max={UTILIZATION_BAR_FULL_SCALE}
                value={Math.min(window.usedPercent / 100, UTILIZATION_BAR_FULL_SCALE)}
              />
              <WireFigure
                value={formatPercent(window.usedPercent / 100)}
                hoverLabel={formatExactPercent(window.usedPercent)}
              />
            </td>
            <td>
              {window.resetsAt === undefined ? (
                <span className="meridian-settings-page__aside">Not published</span>
              ) : (
                <WireFigure
                  value={formatDateTime(window.resetsAt, clockLocale)}
                  hoverLabel={formatZonedDateTime(window.resetsAt, clockLocale)}
                />
              )}
            </td>
            <td>
              <WireFigure
                value={formatDateTime(window.observedAt, clockLocale)}
                hoverLabel={formatZonedDateTime(window.observedAt, clockLocale)}
              />{" "}
              <Chip label={codeWords(window.source)} />
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

/**
 * How long a window runs, read as a duration, with the minutes the provider reported in its hover
 * label.
 */
function WindowLength(props: { readonly window: AccountQuotaRow["window"] }): React.JSX.Element {
  const { windowMins } = props.window;
  return (
    <WireFigure
      value={formatDuration(windowMins * MILLISECONDS_PER_MINUTE)}
      hoverLabel={formatWholeDuration(windowMins, "minute")}
    />
  );
}
