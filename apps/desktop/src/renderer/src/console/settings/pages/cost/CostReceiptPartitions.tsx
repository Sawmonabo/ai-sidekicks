// The three splits a session cost receipt is drawn as, and the one table that draws
// them.
//
// Split out of `CostReceiptPage.tsx` because a column table and a page are two
// different subjects: the page owns the READ and the settlement, and this owns what
// a split looks like once one has arrived. Every value here is a prop, so a case can
// drive all three splits — and the failed-verification arm — with no bridge at all.
//
// ONE TABLE, THREE COLUMN SETS. Generic over the row, so the splits share one piece
// of scaffolding rather than three copies of it: the columns carry what differs, and
// the type parameter keeps each column's accessor bound to the row it reads.

import type { ReactNode } from "react";

import { DerivedFigure, Nothing, WireFigure } from "../../../primitives/index.js";
import {
  BILLING_MODE_CLAUSES,
  formatCentsAsCurrency,
  type CostReceiptAccountRow,
  type CostReceiptCausedByRow,
  type CostReceiptRunRow,
} from "./cost-receipt-model.js";

/** One column of a split's table: its heading, and how a row fills it. */
export interface PartitionColumn<TRow> {
  readonly label: string;
  /** True for the money column, which shares one right edge down the table. */
  readonly isAmount?: boolean;
  readonly render: (row: TRow) => ReactNode;
}

export const RUN_COLUMNS: readonly PartitionColumn<CostReceiptRunRow>[] = [
  { label: "Run", render: (row) => <WireFigure value={row.runId} /> },
  { label: "Cost", isAmount: true, render: (row) => <MoneyFigure cents={row.costCents} /> },
  { label: "Pricing", render: (row) => <WireFigure value={row.costStatus} /> },
  { label: "Scope", render: (row) => <WireFigure value={row.aggregationScope} /> },
];

export const CAUSED_BY_COLUMNS: readonly PartitionColumn<CostReceiptCausedByRow>[] = [
  {
    label: "Party",
    render: (row) =>
      // The system arm carries no identifier at all, so it is named in the console's
      // own words and can never be mistaken for something the daemon sent.
      row.party.kind === "system" ? (
        <DerivedFigure text="the machine itself" />
      ) : (
        <WireFigure value={row.party.participantId} />
      ),
  },
  { label: "Cost", isAmount: true, render: (row) => <MoneyFigure cents={row.costCents} /> },
  { label: "Pricing", render: (row) => <WireFigure value={row.costStatus} /> },
];

export const ACCOUNT_COLUMNS: readonly PartitionColumn<CostReceiptAccountRow>[] = [
  { label: "Account", render: (row) => <WireFigure value={row.displayLabel} /> },
  {
    label: "Charged as",
    render: (row) => (
      <>
        <WireFigure value={row.billingMode} />
        <span className="meridian-cost-receipt__cell-note">
          {BILLING_MODE_CLAUSES[row.billingMode]}
        </span>
      </>
    ),
  },
  { label: "Cost", isAmount: true, render: (row) => <MoneyFigure cents={row.costCents} /> },
  { label: "Pricing", render: (row) => <WireFigure value={row.costStatus} /> },
];

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

/**
 * A cents figure as money, with the daemon's own integer on the title — where the
 * eight rules put the number a formatted figure would otherwise hide. Four call
 * sites, so it is written once.
 */
export function MoneyFigure(props: { readonly cents: number }): ReactNode {
  return <WireFigure value={formatCentsAsCurrency(props.cents)} title={String(props.cents)} />;
}
