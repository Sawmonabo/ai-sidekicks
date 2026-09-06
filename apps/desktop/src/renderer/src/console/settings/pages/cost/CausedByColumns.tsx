// The per-caused-by split's columns.
//
// One of three column sets the session cost receipt's splits are drawn with — see
// `RunColumns.tsx` for why each is its own module and how the naming rule reaches a
// `.tsx` module whose one declaration is a table.

import { DerivedFigure, WireFigure } from "../../../primitives/index.js";
import type { CostReceiptCausedByRow } from "./cost-receipt-model.js";
import { MoneyFigure } from "./MoneyFigure.js";
import type { PartitionColumn } from "./partition-column.js";

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
