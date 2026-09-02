// The cost page: one figure, and what it is made of.
//
// `Spec-023 §Console Design (Meridian)` §The session cost receipt is a decomposition
// and never a calculator. One accountant produces the figure a session is charged,
// and the receipt shows the same figure split three ways — per run, per party that
// caused the spend, and per account that pays for it. Each split accounts for the
// whole figure, which is what makes the receipt answerable rather than merely
// itemised.
//
// WHY THIS PAGE RENDERS NO NUMBER TODAY
//
// The read that supplies the figure and the read that decomposes it are not wires
// this console has: neither is registered in the contracts package, neither is on
// the growth slate, and nothing on the preload bridge answers for them. So the page
// asks nothing and shows nothing, and says which of the five absences that is — no
// question was put. The alternative would be a zero, and a zero here is a claim: it
// would say the session has spent nothing, which is a different sentence from
// nobody having asked.
//
// WHY THE RULES ARE IN THE FRAME
//
// Every rule below is one this page keeps by having no arithmetic in it at all, and
// each is easy to break the day the figure arrives — a partition table is exactly
// the place a total gets recomputed "for consistency". Stating them in the frame,
// with a test holding them, is what makes the body land into a page that already
// forbids it.

import type { ReactNode } from "react";

import { Chip, Nothing } from "../../primitives/index.js";
import { DefinitionGrid } from "./DefinitionGrid.js";
import type { SettingsPageRegistry } from "../settings-page-registry.js";

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
];

export function CostReceiptPage(): ReactNode {
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

      <Nothing
        kind="not-checked"
        placement="surface"
        title="No cost figure has been asked for."
        detail="The read that supplies the session figure and the read that decomposes it are not wires this window has. Nothing was asked, so nothing here is a reading — and a zero would have been a claim that the session has spent nothing."
      />
    </div>
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
    render: () => <CostReceiptPage />,
  });
}
