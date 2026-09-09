// Where a row's offers meet the surfaces that carry them out.
//
// THE BUILDER NEXT DOOR IS PURE AND THIS ONE IS NOT, which is the whole reason they
// are two modules: `ledger-row-offers.ts` decides WHICH offers a row carries and is
// driven with no render at all, and this decides what each one reaches — the list's
// lease table, the ledger's one scroll writer, the replay engine, and the host's
// clipboard and file reveal. A test of the first needs four lambdas; a test of this
// needs a bridge.
//
// EVERY ACT IS RESOLVED AT PRESS TIME, `ledger-feed-acts.ts`' rule and for a sharper
// version of its reason. The binding is handed to `LedgerFeedRow`, whose memo
// compares it: a binding rebuilt when the window moved would move on every admitted
// event and take every mounted row's card down with it. So the identity is minted
// once and the live surface is read through a ref — and the ref is written from the
// LAYOUT phase, never the render body, for `ledger-actor-follow-seat.ts`' reason: a
// render pass React discards still runs the body, and a press against a window that
// never reached the screen would scroll to a row nobody can see.
//
// AND BOTH HOST CALLS ARE WRAPPED AT THE CALL RATHER THAN AT THE PROMISE.
// `palette/commands/bridge-commands.ts` records why: the shipped bridge implements every
// method as a synchronous `throw` while the fixture returns a rejected promise, so a
// boundary attached only to the returned promise catches the fixture and lets the
// release build's throw escape into a press handler that drops it — and the person
// who pressed the control sees nothing at all on the one build they actually run.
// Both arms end at the same refusal, because a person who pressed "copy" needs to
// know the copy did not happen and not which layer declined.
//
// THE REFUSALS GO THROUGH THE CONSOLE'S ACT CHANNEL rather than into per-row state.
// A row is one of thousands in a virtualized window; a `useState` per row for a
// failure almost none of them will ever have is duplicate state the density budget
// forbids, and it would die with the row the moment the viewport scrolled past it.
// The channel is what the ledger's chord acts already use, so one press and one
// chord that fail the same way say the same sentence in the same place.

import { Menu } from "@base-ui/react/menu";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { FilePathRef, TimelineRow } from "@ai-sidekicks/contracts";

import { useConsoleBridge, type ConsoleBridge } from "../../../../bridge/index.js";
import { refuse, type ConsoleRefusal } from "../../../../core/index.js";
import { raiseConsoleActRefusal } from "../../../../palette/index.js";
import { type TimelineRowDensity } from "../../../../seats/index.js";
import { type LedgerRowLease } from "../../../frame/index.js";
import { buildLedgerRowOffers, type LedgerRowOffer } from "./ledger-row-offers.js";

/**
 * What "copy entry id" answers when the host would not take it.
 *
 * One sentence for both failure arms, because the next move is the same and the
 * layer that declined is not something a person can act on. The id is still on
 * screen, which is what makes stating the failure better than a silent no-op: a
 * press that reported nothing would leave somebody pasting whatever was on the
 * clipboard before.
 */
export const LEDGER_ROW_ID_NOT_COPIED_REFUSAL: ConsoleRefusal = refuse(
  "ledger",
  "ledger.row_id_not_copied",
  "This entry's id could not be copied. The clipboard belongs to the main process, and this window could not reach it.",
);

/**
 * What "copy body" answers when the host would not take it.
 *
 * Its own code rather than the id's, because the two presses fail over different
 * amounts of text and a reader who could not copy a forty-kilobyte tool result is
 * not in the same position as one who could not copy a thirty-character id.
 */
export const LEDGER_BODY_NOT_COPIED_REFUSAL: ConsoleRefusal = refuse(
  "ledger",
  "ledger.body_not_copied",
  "This entry's body could not be copied. The clipboard belongs to the main process, and this window could not reach it.",
);

/** What "reveal file" answers when the host would not open the file manager. */
export const LEDGER_FILE_NOT_REVEALED_REFUSAL: ConsoleRefusal = refuse(
  "ledger",
  "ledger.file_not_revealed",
  "The file could not be revealed. Opening a file manager belongs to the main process, and this window could not reach it.",
);

/** The live surfaces one window's row offers act on. Read at press time. */
export interface LedgerRowOfferSurface {
  /** This row's leased body state, so a disclosure press keeps its inner offset. */
  readonly rowLease: (rowKey: string) => LedgerRowLease | undefined;
  readonly setRowLease: (rowKey: string, lease: LedgerRowLease) => void;
  /** The ledger's one scroll writer. A chapter header is keyed by its run id. */
  readonly jumpToRow: (rowKey: string) => void;
  /** Reveal the dock and scrub to one row. Owns its own refusal. */
  readonly replayFromRow: (rowId: string) => void;
  readonly bridge: ConsoleBridge;
}

/**
 * What a row knows about itself when it asks for its offers.
 *
 * A record rather than a positional list: three of the four members are optional
 * facts a row may or may not have, and a call site passing `undefined` twice in a
 * row is one transposition away from asking about the wrong thing.
 */
export interface LedgerRowOfferRequest {
  readonly row: TimelineRow;
  /** The collapse state the list handed this row, lease already overlaid. */
  readonly density: TimelineRowDensity;
  /** The run whose chapter THIS window draws for the row, resolved by the caller. */
  readonly chapterRunId: string | undefined;
  /**
   * The row's machine-authored body as this console has read it, or `undefined`.
   *
   * Carried on the REQUEST and not resolved here, because whether a body has been
   * read is the caller's fact and not the binding's: the seat a row is rendered
   * through carries no body at all today, and the day the hydrated read serves one
   * the value arrives at the row before it arrives here.
   */
  readonly bodyText: string | undefined;
  /**
   * The opaque path token this row carries, or `undefined` when it carries none.
   *
   * On the request for `bodyText`'s reason and one of its own: `FilePathRef` is
   * branded so that only the main process can mint one, which makes the offer's
   * absence structural rather than a rule this module keeps — and a constant here
   * would put that absence somewhere a caller cannot see it while making the reveal
   * act unreachable from anything, tests included.
   */
  readonly pathReference: FilePathRef | undefined;
}

/**
 * Which offers a row carries, and what each one reaches.
 *
 * The half of the binding that needs no menu and no React tree, so the suite that
 * drives the behaviour drives exactly this.
 */
export interface LedgerRowOfferResolution {
  readonly offersFor: (request: LedgerRowOfferRequest) => readonly LedgerRowOffer[];
}

/**
 * The one menu every row in a window opens, keyed by what that row asked about.
 *
 * `Payload` is the row's own request, so the popup that opens is filled from the
 * trigger that opened it rather than from a row identity the popup would have to
 * look back up.
 */
export type LedgerRowOffersHandle = Menu.Handle<LedgerRowOfferRequest>;

/** The stable handle a row asks for its own offers through. */
export interface LedgerRowOffersBinding extends LedgerRowOfferResolution {
  /**
   * The window's ONE menu, which every row's trigger opens and one popup fills.
   *
   * A handle rather than a menu per row, and the difference is the whole reason this
   * member exists: `Menu.Root` builds a floating-tree node, a positioner, a popup
   * store, and an interaction stack, and a window mounts as many rows as the
   * viewport holds. Measured over the endurance tier's churn, one of those machines
   * per mounted row was megabytes of retained heap for a menu at most one row has
   * open. Base UI publishes the detached-trigger arrangement for exactly this: the
   * handle is minted once for the mount, every row's trigger names it, and the feed
   * mounts the single root it drives.
   */
  readonly menuHandle: LedgerRowOffersHandle;
}

/**
 * Bind a window's row offers to the surfaces that carry them out.
 *
 * Separate from the hook below so the behaviour can be driven without a React tree —
 * `palette/commands/bridge-commands.ts`' split, for its reason: the hook is the wiring and
 * this is the behaviour, and a test that had to render to reach the behaviour would
 * be proving both at once.
 */
export function buildLedgerRowOffersBinding(
  readSurface: () => LedgerRowOfferSurface,
): LedgerRowOfferResolution {
  const setDensity = (rowId: string, density: TimelineRowDensity): void => {
    const surface = readSurface();
    // The parked offset is CARRIED rather than reset. A row with a clamped body
    // parks where the reader left it, and a disclosure press is about whether the
    // body shows — not about scrolling it back to the top.
    surface.setRowLease(rowId, {
      density,
      innerScrollTopPx: surface.rowLease(rowId)?.innerScrollTopPx ?? 0,
    });
  };
  return {
    offersFor: (request) =>
      buildLedgerRowOffers({
        row: request.row,
        density: request.density,
        setDensity,
        copyRowId: (rowId) => {
          performHostCall(
            () => readSurface().bridge.sidekicks.native.copyToClipboard(rowId),
            LEDGER_ROW_ID_NOT_COPIED_REFUSAL,
          );
        },
        bodyText: request.bodyText,
        copyBody: (bodyText) => {
          performHostCall(
            () => readSurface().bridge.sidekicks.native.copyToClipboard(bodyText),
            LEDGER_BODY_NOT_COPIED_REFUSAL,
          );
        },
        replayFromRow: (rowId) => {
          readSurface().replayFromRow(rowId);
        },
        chapterRunId: request.chapterRunId,
        jumpToChapter: (runId) => {
          readSurface().jumpToRow(runId);
        },
        pathReference: request.pathReference,
        revealFileAtPath: (pathReference) => {
          performHostCall(
            () => readSurface().bridge.sidekicks.native.revealInFileExplorer(pathReference),
            LEDGER_FILE_NOT_REVEALED_REFUSAL,
          );
        },
      }),
  };
}

/**
 * Hold this window's row offers for as long as the feed is mounted.
 *
 * The bridge is read here rather than passed, for `LedgerFeedRow`'s reason about the
 * footer seat: it is a context read, identity-stable for the life of the window, and
 * threading it down through the row renderer would put a second copy of one value in
 * the props chain the memo compares.
 */
export function useLedgerRowOffers(
  surface: Omit<LedgerRowOfferSurface, "bridge">,
): LedgerRowOffersBinding {
  const bridge = useConsoleBridge();
  // THE REF HOLDS THE FEED'S SURFACES AND NOT THE BRIDGE, which is the console's own
  // rule about mount-lifetime cells: a cell that names the bridge where it is
  // produced and not where it is re-derived is a value keyed on a bridge it will
  // never be produced for again. The bridge is a dependency of the memo instead —
  // the shape the palette's command list is written in — so the binding is rebuilt
  // if and only if the window is rendering against a different bridge, and holds its
  // identity across every render that is not.
  const committedSurfaceRef = useRef(surface);
  useLayoutEffect(() => {
    committedSurfaceRef.current = surface;
  });
  // MINTED ONCE FOR THE MOUNT and never re-derived, because it is the identity two
  // sides of one seam agree on: a row's trigger names it and the feed's one root
  // attaches to it, and a handle rebuilt mid-mount would leave every already-rendered
  // trigger pointing at a root that is no longer listening.
  const [menuHandle] = useState<LedgerRowOffersHandle>(() =>
    Menu.createHandle<LedgerRowOfferRequest>(),
  );
  return useMemo(
    () => ({
      ...buildLedgerRowOffersBinding(() => ({ ...committedSurfaceRef.current, bridge })),
      menuHandle,
    }),
    [bridge, menuHandle],
  );
}

/**
 * Perform one host call, and answer either kind of failure with one refusal.
 *
 * The call is made INSIDE the `try` deliberately — see this module's header for the
 * synchronous-throw arm that placement is the whole point of.
 */
function performHostCall(call: () => Promise<void>, refusal: ConsoleRefusal): void {
  try {
    call().catch(() => {
      raiseConsoleActRefusal(refusal);
    });
  } catch {
    raiseConsoleActRefusal(refusal);
  }
}
