// What one row offers, decided once, over values the feed already holds.
//
// THE OFFERS ARE THE ROW'S, NOT THE WINDOW'S, which is why they are not nine more
// members on `LedgerStructureActs`. A palette chord fires with no row in hand — it
// resolves an anchor from the viewport's own range — and every offer here is about
// one row a person pointed at. Two questions, two homes: `ledger-feed-acts.ts` owns
// what a chord does to the ledger, this owns what a control does to a row.
//
// A PURE BUILDER OVER A VALUE BAG, so the whole set is driven by a test with no
// render at all — `ledger-feed-acts.ts`' property, for its reason. Nothing below
// reaches a store, a bridge, or the DOM: the clipboard is the binding's, the scroll
// is the viewport's, and the chapter lookup happened before this ran.
//
// EVERY OFFER IS FAIL-CLOSED ON A FACT RATHER THAN ON A GUESS. An offer that cannot
// succeed is not rendered disabled and is not rendered at all:
//
//   • The chapter jump appears when THIS window holds a chapter for the row's run.
//     A row whose run has no chapter here — a live run, a filtered window, a run
//     whose header the cap took — would jump to a header that is not on screen and
//     report that it moved.
//   • The body copy appears when the row's machine-authored body has been READ. The
//     seat carries no body — the hydrated read that opens one is unregistered, so
//     `MachineBody` renders the named absence for every machine row on this build —
//     and copying a body the console does not hold would put the empty string on
//     somebody's clipboard and report a copy.
//   • The file reveal appears when the row carries an opaque path token. The token
//     is minted by the main process and the renderer cannot build one from a string
//     (`FilePathRef` is branded exactly so), so the offer's absence is structural
//     rather than a convention this module keeps.
//
// AND OPEN AND CLOSE ARE TWO OFFERS RATHER THAN ONE TOGGLE WITH A COMPUTED LABEL.
// A menu item reads as a verb, and "Open"/"Close" are two verbs about two states —
// which is also what makes the pair assertable: a test names the kind it expects
// rather than matching a label that flipped.

import type { FilePathRef, TimelineRow } from "@ai-sidekicks/contracts";

import { type TimelineRowDensity } from "../../../../seats/index.js";

/**
 * Every offer a row can carry. Closed.
 *
 * The tuple is the declaration and the union is derived from it, for the reason
 * `cards/card-family.ts` gives about its own family set: an offer added to a
 * hand-written union while the builder below did not grow with it would be a kind
 * nothing can produce, and nothing would report it.
 */
export const LEDGER_ROW_OFFER_KINDS = [
  "open-row",
  "close-row",
  "copy-row-id",
  "copy-body",
  "jump-to-chapter",
  "reveal-file-at-path",
] as const;

/** One offer's identity. Derived from the enumeration, never restated. */
export type LedgerRowOfferKind = (typeof LEDGER_ROW_OFFER_KINDS)[number];

/** One offer: what it is, what it reads as, and what pressing it does. */
export interface LedgerRowOffer {
  readonly kind: LedgerRowOfferKind;
  /** The verb a person reads. Sentence case, no trailing punctuation. */
  readonly label: string;
  readonly perform: () => void;
}

/** What one row's offers are built over. Every member is a value, never a store. */
export interface LedgerRowOfferInputs {
  readonly row: TimelineRow;
  /** The collapse state the list handed this row, lease already overlaid. */
  readonly density: TimelineRowDensity;
  /** Write this row's collapse state to the list. Never held privately by a row. */
  readonly setDensity: (rowId: string, density: TimelineRowDensity) => void;
  /** Put the row's canonical event id on the clipboard, refusal and all. */
  readonly copyRowId: (rowId: string) => void;
  /**
   * The row's machine-authored body as this console has read it, or `undefined`.
   *
   * `undefined` is "not read", never "empty": the two are different facts, and the
   * offer below is built on the first. An empty string is a body that was read and
   * says nothing, which is copyable and offered.
   */
  readonly bodyText: string | undefined;
  /** Put a body on the clipboard, refusal and all. */
  readonly copyBody: (bodyText: string) => void;
  /**
   * The run whose chapter THIS window holds for this row, or `undefined`.
   *
   * Resolved by the caller against the window on screen rather than read off the
   * row, because "which run is this" and "does this window draw that run's header"
   * are two questions and only the second decides whether a jump can land.
   */
  readonly chapterRunId: string | undefined;
  /** Scroll to a chapter header by the run id the header is keyed by. */
  readonly jumpToChapter: (runId: string) => void;
  /**
   * The opaque path token this row carries, or `undefined` when it carries none.
   *
   * A `FilePathRef` and never a string: the main process mints the token and
   * dereferences it, and the renderer never sees a path. So a row can only carry
   * one once the timeline read serves one, and this member is the whole of that
   * dependency — nothing here parses a path out of a body.
   */
  readonly pathReference: FilePathRef | undefined;
  /** Ask the host to reveal the file the token names. */
  readonly revealFileAtPath: (pathReference: FilePathRef) => void;
}

/**
 * The offers this row carries, in the order a menu draws them.
 *
 * Ordered by how often a reader reaches for one rather than alphabetically: the
 * disclosure first because it is the row's own state, then the two copies — the id
 * every bug report quotes, then the body — then the two navigations, then the host
 * hand-off.
 */
export function buildLedgerRowOffers(inputs: LedgerRowOfferInputs): readonly LedgerRowOffer[] {
  const rowId = inputs.row.id;
  const offers: LedgerRowOffer[] = [
    inputs.density === "expanded"
      ? {
          kind: "close-row",
          label: "Close",
          perform: () => {
            inputs.setDensity(rowId, "collapsed");
          },
        }
      : {
          kind: "open-row",
          label: "Open",
          perform: () => {
            inputs.setDensity(rowId, "expanded");
          },
        },
    {
      kind: "copy-row-id",
      label: "Copy entry id",
      perform: () => {
        inputs.copyRowId(rowId);
      },
    },
  ];

  // BESIDE THE ID AND NOT AT THE END, because it is the second half of the copy pair:
  // a reader who opened the menu to quote something wants both together, and every
  // offer after this one is about going somewhere rather than taking something away.
  // Pushed in position rather than spliced in later — an index into a list two
  // conditionals can lengthen is a number that stops meaning what it says.
  const bodyText = inputs.bodyText;
  if (bodyText !== undefined) {
    offers.push({
      kind: "copy-body",
      label: "Copy body",
      perform: () => {
        inputs.copyBody(bodyText);
      },
    });
  }

  const chapterRunId = inputs.chapterRunId;
  if (chapterRunId !== undefined) {
    offers.push({
      kind: "jump-to-chapter",
      label: "Jump to run chapter",
      perform: () => {
        inputs.jumpToChapter(chapterRunId);
      },
    });
  }

  const pathReference = inputs.pathReference;
  if (pathReference !== undefined) {
    offers.push({
      kind: "reveal-file-at-path",
      label: "Reveal file",
      perform: () => {
        inputs.revealFileAtPath(pathReference);
      },
    });
  }

  return offers;
}
