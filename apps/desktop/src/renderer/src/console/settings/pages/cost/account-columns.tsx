// The per-paying-account split's columns.
//
// One of three column sets the session cost receipt's splits are drawn with — see
// `run-columns.tsx` for why each is its own module and why the name is kebab.

import { WireFigure } from "../../../primitives/index.js";
import { BILLING_MODE_CLAUSES, type CostReceiptAccountRow } from "./cost-receipt-model.js";
import { MoneyFigure } from "./MoneyFigure.js";
import type { PartitionColumn } from "./partition-column.js";

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
