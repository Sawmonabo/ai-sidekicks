// The cost page: one figure, and what it is made of.
//
// `Spec-023 §Console Design (Meridian)` §The session cost receipt is a decomposition
// and never a calculator. One accountant produces the figure a session is charged,
// and the receipt shows the same figure split three ways — per run, per party that
// caused the spend, and per account that pays for it. Each split accounts for the
// whole figure, which is what makes the receipt answerable rather than merely
// itemised.
//
// WHAT THIS PAGE ASKS, AND WHAT IT DELIBERATELY DOES NOT
//
// One read, `orchestrationCostReceiptRead`, once per session. The receipt CARRIES the
// budget state as its own session total, so the figure and its decomposition are the
// same value and cannot drift — which is why the budget read beside it on the port is
// not called here: a surface wanting only the total calls that one, a surface wanting
// the breakdown finds the total inside this one, and calling both would be two reads
// of one fold with nothing able to say which answer was newer.
//
// The page is SESSION-SCOPED and the settings address may name no session, which is
// an absence rather than a zero. In flight the absence is `not-loaded`; a refusal
// renders with the daemon's own code and sentence; only a served reply puts a figure
// on screen.
//
// THE VERIFICATION COMPUTES NOTHING THAT IS DISPLAYED
//
// `cost-receipt-model.ts` sums each axis against the figure the daemon settled, and
// that total is a boolean by the time it leaves the module — no caller can render it,
// because none is returned. An axis that does not account for the figure has dropped
// a row or counted one twice, so this page withholds that table rather than showing
// rows it cannot vouch for; the other two still render, because a defect on one axis
// is not evidence against the others.
//
// WHY THE RULES ARE IN THE FRAME
//
// Each rule below is easy to break — a partition table is exactly where a total gets
// recomputed "for consistency" — so they are stated on the page with a test holding
// them, which is what keeps the body inside a frame that forbids it.

import { useEffect, useState, type ReactNode } from "react";

import "./cost-receipt.css";

import { Chip, InlineRefusal, Nothing, useAnnounce } from "../../../primitives/index.js";
import {
  announcementFor,
  verifyReceiptPartitions,
  type CostReceipt,
  type CostReceiptOutcome,
} from "./cost-receipt-model.js";
import { DefinitionGrid } from "../../shared/DefinitionGrid.js";
import {
  ACCOUNT_COLUMNS,
  CAUSED_BY_COLUMNS,
  MoneyFigure,
  PartitionSection,
  RUN_COLUMNS,
} from "./CostReceiptPartitions.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../../settings-page-registry.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-cost";

/** The three ways the one figure is split. Each accounts for the whole of it. */
const RECEIPT_PARTITIONS: readonly { readonly title: string; readonly detail: string }[] = [
  {
    title: "Per run",
    detail:
      "One row per run, each declaring that it counts that run alone. The rows together are the whole figure.",
  },
  {
    title: "Per party",
    detail:
      "One row per participant or for the machine itself, keyed on who the turn was issued by. A turn that carries no such stamp is attributed to whoever started the run, and the row says so rather than guessing.",
  },
  {
    title: "Per paying account",
    detail:
      "One row per provider account the spend lands on, each carrying how that account is charged — so usage included in a plan is never presented as currency owed.",
  },
];

/** What the page will not do, however the figure arrives. */
const RECEIPT_RULES: readonly string[] = [
  "Nothing on screen is added up to produce a total. The figure comes from the one accountant that enforces it.",
  "No figure is called a lower bound, at the session line or on any row.",
  "No total spans sessions. This page answers for one session and says so.",
  "No table breaks the figure down by model. Model pricing is not one of the three splits, and a fourth accountant is what it would take.",
  "The status beside the figure is provenance, never policy — it says how the figure was arrived at and decides nothing.",
  "Each split is checked against the figure before its rows are drawn, and the sum that check takes is never shown.",
];

export function CostReceiptPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const { bridge, retainedSessionId } = props.context;
  const announce = useAnnounce();
  const [outcome, setOutcome] = useState<CostReceiptOutcome | undefined>(undefined);

  useEffect(() => {
    if (retainedSessionId === undefined) {
      return undefined;
    }
    let isAttached = true;
    // Cleared first, so a session change never leaves one session's figure standing
    // under another's name. Not the re-entry a refresh is forbidden: the standing
    // answer was to a question nobody is asking any more.
    setOutcome(undefined);
    void bridge.growth
      .orchestrationCostReceiptRead({ sessionId: retainedSessionId })
      .then((result) => {
        if (!isAttached) {
          return;
        }
        setOutcome(result);
        // Once per settled read, politely: nothing the room can do has moved.
        announce(announcementFor(result));
      });
    return () => {
      isAttached = false;
    };
  }, [bridge, retainedSessionId, announce]);

  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        The cost receipt makes one number answerable. It is the figure the session is charged, shown
        three times over — once per run, once per party that caused the spend, and once per account
        that pays for it — so a person can ask where a figure came from and be answered rather than
        reassured.
      </p>

      <div className="meridian-settings-page__chips">
        <Chip tone="neutral" label="One accountant" glyph="check" />
        <Chip tone="neutral" label="One session" glyph="sessions" />
      </div>

      <ReceiptBody sessionId={retainedSessionId} outcome={outcome} />

      <section className="meridian-settings-page__block" aria-label="How the figure is split">
        <h3 className="meridian-settings-page__block-title">How the figure is split</h3>
        <p className="meridian-settings-page__aside">
          Each split accounts for the whole figure. The per-run rows and the per-party rows are two
          readings of one number, never two numbers that happen to be near each other.
        </p>
        <DefinitionGrid
          entries={RECEIPT_PARTITIONS.map((partition) => ({
            key: partition.title,
            term: partition.title,
            definition: partition.detail,
          }))}
        />
      </section>

      <section className="meridian-settings-page__block" aria-label="What the receipt never does">
        <h3 className="meridian-settings-page__block-title">What the receipt never does</h3>
        <ul className="meridian-settings-page__list">
          {RECEIPT_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** The four states a session-scoped read can be in, and what each one renders. */
function ReceiptBody(props: {
  readonly sessionId: string | undefined;
  readonly outcome: CostReceiptOutcome | undefined;
}): ReactNode {
  if (props.sessionId === undefined) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="The receipt belongs to a session, and this window has opened none."
        detail="Open a session from the Sessions list and its receipt renders here. Nothing was asked of the accountant for a session nobody has opened."
      />
    );
  }
  if (props.outcome === undefined) {
    return (
      <Nothing kind="not-loaded" placement="surface" title="Reading this session's receipt." />
    );
  }
  if (props.outcome.status === "unavailable") {
    return <InlineRefusal code={props.outcome.code} detail={props.outcome.detail} />;
  }
  return <ServedReceipt receipt={props.outcome.value} />;
}

/** The figure, then the three splits of it. */
function ServedReceipt(props: { readonly receipt: CostReceipt }): ReactNode {
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

/** Claim the cost section. See `RuntimeNodesPage.tsx` on the seam's shape. */
export function registerCostReceiptPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "cost",
    owner: OWNER,
    label: "Session cost",
    keywords: [
      "spend",
      "receipt",
      "budget",
      "billing",
      "money",
      "charges",
      "per run",
      "per account",
    ],
    render: (context) => <CostReceiptPage context={context} />,
  });
}
