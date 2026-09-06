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

import { useMemo, type ReactNode } from "react";

import { consoleClockFor } from "../../../bridge/index.js";
import { Chip, useAnnounce } from "../../../primitives/index.js";
import { consoleRefusalFrom } from "../../../seats/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  useSubjectScopedState,
  useWindowReadTriggers,
  type ReadTriggerTarget,
} from "../../../store/index.js";
import {
  announcementFor,
  type CostReceiptReading,
  type RetainedReceipt,
} from "./cost-receipt-model.js";
import { DefinitionGrid } from "../../shared/DefinitionGrid.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../../settings-page-registry.js";
import { ReceiptBody } from "./ReceiptBody.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-cost";

/** Names a read that produced no outcome at all, where the thrown value named none. */
const COST_RECEIPT_ORIGIN = "cost-receipt";

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
  // Bound to the name the read itself uses. The page's context calls it
  // `retainedSessionId` because a settings ADDRESS carries no session and the frame
  // supplies the one this window last opened; inside the page it is simply the
  // session being read, and naming it so is what lets the memo below state its
  // dependency in the same word its request does.
  const { bridge, retainedSessionId: sessionId } = props.context;
  const announce = useAnnounce();
  // HELD FOR THE SESSION IT WAS READ FOR, through the family's one holder. The
  // previous shape was a `useState` cell cleared at the top of the effect, and
  // "cleared first" was first WITHIN THE EFFECT — one committed frame after the
  // render that renamed the subject. That frame painted the previous session's money
  // figures, its per-run rows, and its per-paying-account rows under the new
  // session's name. The holder is addressed during the render, so the pass that
  // first sees a new session already reads that session's own seed.
  const { value: reading, publish: publishReading } = useSubjectScopedState<
    CostReceiptReading | undefined
  >(bridge, sessionId, () => undefined);
  // The last figure this session was actually served, held beside the reading rather
  // than inside it. Subject-scoped like the reading itself, so no other session's
  // figure is ever the one retained under this session's name.
  const { value: retained, publish: publishRetained } = useSubjectScopedState<
    RetainedReceipt | undefined
  >(bridge, sessionId, () => undefined);
  // The scenario's frozen clock under the fixture, the real one otherwise, so a story
  // stamps the retained figure with the same instant it stamps everything else.
  //
  // Resolved through the family's own holder rather than `useConsoleClock`, which
  // reads the bridge PROVIDER: this page is mounted from a settings board that hands
  // it a bridge directly, and reaching for the provider would make the clock a
  // second, stricter requirement than the bridge the page already has. Pinned rather
  // than read per call because the live arm of `consoleClockFor` MINTS — the reading
  // it gives is the same either way, and holding one is what keeps the effect's
  // dependency stable.
  const { value: clock } = useSubjectScopedState(bridge, undefined, () => consoleClockFor(bridge));

  const readTarget = useMemo<ReadTriggerTarget>(
    () => ({
      // Empty, and the emptiness is a claim about the FOLD rather than an omission:
      // the receipt is emitted once per priced turn and its own timeline kinds are
      // not on this window's session store, so nothing here learns from the tail.
      triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
      requestRead: () => {
        if (sessionId === undefined) {
          return;
        }
        // The publisher guards the VALUE — captured during this render, it names the
        // session that asked, so a settlement arriving after a re-address publishes
        // nowhere. The announcement it cannot guard: the announcer is the window's,
        // addressed by nothing, and speaking a figure for a session nobody is looking
        // at is exactly what it must not do — which is why the publisher is what
        // decides whether this settlement is still this page's at all.
        void bridge.growth.orchestrationCostReceiptRead({ sessionId }).then(
          (outcome) => {
            publishReading({ kind: "answered", outcome });
            if (outcome.status === "served") {
              publishRetained({
                receipt: outcome.value,
                readAtIso: new Date(clock.now()).toISOString(),
              });
            }
            // Once per settled read, politely: nothing the room can do has moved.
            announce(announcementFor(outcome));
          },
          // The port's contract is that it resolves, and a rejection is off it — which
          // is why this arm exists rather than being left to the window's unhandled
          // handler. Without it the page renders "Reading this session's receipt" for
          // the life of the window, reporting a read that failed as one still in flight.
          (rejection: unknown) => {
            const refusal = consoleRefusalFrom(rejection, COST_RECEIPT_ORIGIN);
            publishReading({ kind: "unreadable", refusal });
            announce(refusal.detail);
          },
        );
      },
    }),
    [bridge, sessionId, announce, clock, publishReading, publishRetained],
  );
  // The mount and the window regaining focus. A receipt is a SESSION's, but the two
  // session-scoped triggers are deliberately not wired: this page holds no session
  // store to read a timeline or a repair edge from, and asking for one here would tie
  // the figure to whichever store the settings address happened to resolve.
  useWindowReadTriggers(readTarget);

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

      <ReceiptBody sessionId={sessionId} reading={reading} retained={retained} />

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
