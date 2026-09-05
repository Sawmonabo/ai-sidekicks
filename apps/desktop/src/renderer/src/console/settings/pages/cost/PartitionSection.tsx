// The one table all three of a cost receipt's splits are drawn as.
//
// Its own module because a component is one subject: the column sets it renders are
// `run-columns.tsx` and its two siblings, and the money figure their amount column uses is
// `MoneyFigure.tsx`. Every value here is a prop, so a case can drive all three
// splits — and the failed-verification arm — with no bridge at all.

import type { ReactNode } from "react";

import { Nothing } from "../../../primitives/index.js";
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
      <h3 className="meridian-settings-page__block-title">{props.label}</h3>
      {body}
    </section>
  );
}
