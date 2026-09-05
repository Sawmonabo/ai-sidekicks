import { type ReactNode } from "react";
import { Chip } from "../../../primitives/index.js";
import { verifyReceiptPartitions, type CostReceipt } from "./cost-receipt-model.js";
import { ACCOUNT_COLUMNS } from "./account-columns.js";
import { CAUSED_BY_COLUMNS } from "./caused-by-columns.js";
import { RUN_COLUMNS } from "./run-columns.js";
import { MoneyFigure } from "./MoneyFigure.js";
import { PartitionSection } from "./PartitionSection.js";

/** The figure, then the three splits of it. */
export function ServedReceipt(props: { readonly receipt: CostReceipt }): ReactNode {
  const { receipt } = props;
  const verdicts = verifyReceiptPartitions(receipt);
  const { committedSpendCents, costStatus } = receipt.sessionTotal;
  return (
    <>
      <section className="meridian-settings-page__block" aria-label="What this session is charged">
        <h3 className="meridian-settings-page__block-title">What this session is charged</h3>
        <div className="meridian-cost-receipt__figure-line">
          <p className="meridian-cost-receipt__figure">
            <MoneyFigure cents={committedSpendCents} />
          </p>
          <Chip tone="neutral" label={costStatus} mono />
          <p className="meridian-cost-receipt__figure-caption">
            The status beside the figure says how it was arrived at. It decides nothing.
          </p>
        </div>
      </section>

      <PartitionSection
        label="Per run"
        caption="Every row carries its own scope, and the scope says the row counts that one run and nothing beside or beneath it. It is the row's declaration rather than this page's reading of it."
        columns={RUN_COLUMNS}
        rows={receipt.runs}
        keyOf={(row) => row.runId}
        accountsForFigure={verdicts.runs}
        emptyTitle="No run has spent anything in this session."
        emptyDetail="A run appears here once the accountant has priced it."
      />

      <PartitionSection
        label="Per party"
        caption="Spend nobody asked for — a sweep, an idle settlement, a recovery turn — is the machine's own and says so, rather than arriving as a party with no name."
        columns={CAUSED_BY_COLUMNS}
        rows={receipt.causedBy}
        keyOf={(row) => (row.party.kind === "system" ? "system" : row.party.participantId)}
        accountsForFigure={verdicts.causedBy}
        emptyTitle="No spend has been attributed to anyone in this session."
        emptyDetail="A row appears here for each participant whose turn caused spend, and one for the machine itself."
      />

      <PartitionSection
        label="Per paying account"
        caption="How an account is charged labels its figure and never changes how the figure was derived."
        columns={ACCOUNT_COLUMNS}
        rows={receipt.byAccount}
        keyOf={(row) => row.providerAccountId}
        accountsForFigure={verdicts.byAccount}
        emptyTitle="No provider account has been charged for this session."
        emptyDetail="A row appears here for each account the spend lands on, with how that account is charged."
      />
    </>
  );
}
