// The one table all three of a cost receipt's splits are drawn as.
//
// Its own module because a component is one subject: the column sets it renders are
// `RunColumns.tsx` and its two siblings, and the money figure their amount column uses is
// `MoneyFigure.tsx`. Every value here is a prop, so a case can drive all three
// splits — and the failed-verification arm — with no bridge at all.
//
// CLOSED BY DEFAULT, AND EACH ONE INDEPENDENTLY. The receipt opens on one line — the
// figure — because that is what the page is for: a person arrives wanting the number
// and stays only when they want to know where it came from. Three tables unrolled
// under it made the answer the page leads with a scroll away, and made the three
// splits look like three separate reports rather than three readings of one figure.
//
// A NATIVE DISCLOSURE, AND NOTHING REMEMBERED. `<details>` is keyboard-reachable and
// announced as expandable without this file re-deriving any of it, and the open state
// is the element's own — so there is nothing to restore after a re-render and nothing
// to persist. `console/persistence/` admits a closed set of value classes and a
// reader's momentary interest in one table is not among them; widening that set is a
// spec amendment rather than a table's decision.
//
// THE SUMMARY LINE SAYS WHAT IS INSIDE. A disclosure whose label is only "Per run" is
// a control a person has to open to find out whether it is worth opening. The count
// comes from the rows this component was handed, which is a count of what is there
// rather than a figure about money — the page's rule forbids the second and says
// nothing about the first.

import type { ReactNode } from "react";

import { Nothing, formatCount } from "../../../primitives/index.js";
import type { PartitionColumn } from "./partition-column.js";

/**
 * One split: its rows, or the reason they are not there.
 *
 * Generic over the row, so the three splits share one table rather than three copies
 * of one scaffolding: the columns carry what differs, and the type parameter keeps
 * each column's accessor bound to the row it reads.
 *
 * The failed-verification arm is checked FIRST and renders as the refusal kind of
 * absence — a split that does not account for the figure is neither empty nor
 * unasked, and its rows are withheld rather than drawn as though they added up.
 */
export function PartitionSection<TRow>(props: {
  readonly label: string;
  readonly caption: string;
  readonly columns: readonly PartitionColumn<TRow>[];
  readonly rows: readonly TRow[];
  readonly keyOf: (row: TRow) => string;
  readonly accountsForFigure: boolean;
  readonly emptyTitle: string;
  readonly emptyDetail: string;
}): ReactNode {
  const summary = !props.accountsForFigure
    ? "withheld"
    : `${formatCount(props.rows.length)} ${props.rows.length === 1 ? "row" : "rows"}`;
  let body: ReactNode;
  if (!props.accountsForFigure) {
    body = (
      <Nothing
        kind="error"
        placement="surface"
        title="This split does not account for the figure."
        detail="Its rows do not come to the amount this session is charged, so one has been counted twice or left out. They are withheld rather than shown as a breakdown of a number they do not break down."
      />
    );
  } else if (props.rows.length === 0) {
    body = (
      <Nothing
        kind="empty"
        placement="surface"
        title={props.emptyTitle}
        detail={props.emptyDetail}
      />
    );
  } else {
    body = (
      <div className="meridian-cost-receipt__scroll">
        <table className="meridian-cost-receipt__table">
          <caption>{props.caption}</caption>
          <thead>
            <tr>
              {props.columns.map((column) => (
                <th key={column.label} scope="col">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <tr key={props.keyOf(row)}>
                {props.columns.map((column) => (
                  <td
                    key={column.label}
                    className={
                      column.isAmount === true ? "meridian-cost-receipt__amount" : undefined
                    }
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <section className="meridian-settings-page__block" aria-label={props.label}>
      <details className="meridian-cost-receipt__split">
        <summary className="meridian-cost-receipt__split-summary">
          <span className="meridian-settings-page__block-title">{props.label}</span>
          <span className="meridian-cost-receipt__split-count">{summary}</span>
        </summary>
        {body}
      </details>
    </section>
  );
}
