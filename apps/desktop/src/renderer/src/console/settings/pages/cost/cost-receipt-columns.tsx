// The three column sets a session cost receipt's splits are drawn with.
//
// A module of its own beside the table that consumes them: a column set is data — a
// heading and an accessor per column — and the table that renders it is a component.
// Keeping them apart is what lets a fourth split be added by writing one array rather
// than by editing a component. A kebab name because that is what this is, and `.tsx`
// because an accessor returns a node.
//
// ONE TABLE, THREE COLUMN SETS. The column type is generic over the row, so the
// splits share one piece of scaffolding rather than three copies of it: the columns
// carry what differs, and the type parameter keeps each column's accessor bound to
// the row it reads.

import type { ReactNode } from "react";

import { DerivedFigure, WireFigure } from "../../../primitives/index.js";
import {
  BILLING_MODE_CLAUSES,
  type CostReceiptAccountRow,
  type CostReceiptCausedByRow,
  type CostReceiptRunRow,
} from "./cost-receipt-model.js";
import { MoneyFigure } from "./MoneyFigure.js";

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
