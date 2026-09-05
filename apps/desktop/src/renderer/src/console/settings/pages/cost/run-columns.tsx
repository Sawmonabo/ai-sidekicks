// The per-run split's columns.
//
// One of three column sets the session cost receipt's splits are drawn with, each in
// its own module beside the table that renders them. A column set is DATA — a heading
// and an accessor per column — so a fourth split is added by writing one array rather
// than by editing a component. A kebab name because that is what this is, and `.tsx`
// because an accessor returns a node.

import { WireFigure } from "../../../primitives/index.js";
import type { CostReceiptRunRow } from "./cost-receipt-model.js";
import { MoneyFigure } from "./MoneyFigure.js";
import type { PartitionColumn } from "./partition-column.js";

export const RUN_COLUMNS: readonly PartitionColumn<CostReceiptRunRow>[] = [
  { label: "Run", render: (row) => <WireFigure value={row.runId} /> },
  { label: "Cost", isAmount: true, render: (row) => <MoneyFigure cents={row.costCents} /> },
  { label: "Pricing", render: (row) => <WireFigure value={row.costStatus} /> },
  { label: "Scope", render: (row) => <WireFigure value={row.aggregationScope} /> },
];
