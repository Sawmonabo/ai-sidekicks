// Every window this feed derives, in the one order they may be derived in.
//
// WHAT THIS MODULE OWNS. A ledger pane holds a chain of windows, not one: the whole
// unfurled projection, the same projection narrowed by the ledger filter, that narrowing
// with finished chapters folded, and finally the part the viewport reconciled onto
// the screen. Each stage is somebody else's derivation — `ledger-window.ts`',
// `ledger-narrowing.ts`', `ledger-chapter-fold.ts`', `viewport-binding.ts`',
// `ledger-visible-window.ts`' — and what this module adds is the ORDER and nothing
// else. It folds no log, measures no row and writes no `scrollTop`.
//
// WHY THE ORDER IS THE PRODUCT. Two of the stages are only truthful in one
// position, and the reasons are stated at each call below: the narrowing runs on the
// unfurled projection so no piece downstream has to remember a filter exists, and the
// chapter fold runs AFTER the narrowing or a closed terminal chapter reaches the
// filter as one receipt. A caller that composed these stages itself would be free to
// get that wrong, and the failure is silent: every ordering renders rows.
//
// AND WHY EACH STAGE'S OWN REPORT LEAVES WITH IT. The counts beside the find
// field are made of exactly these separations — a match the cap took, one the filter
// is hiding, one a folded chapter holds are three states with three different
// exits — so the stage that removed the rows is the one that publishes them.
// Re-deriving the difference downstream re-walked the whole projection on every
// appended row for as long as a query sat in the field.
//
// WHY THE VIEWPORT BINDING IS DERIVED HERE RATHER THAN BESIDE THE ARRANGEMENT. The
// last window in the chain is read back off the viewport's own reconciled snapshot,
// so find looks at what is on screen rather than at the log behind it — which puts
// the binding INSIDE the chain rather than downstream of it. There is exactly one
// binding, minted here: a second one would leave the find walk reading a virtualizer
// with no element under it, which is a jump that reports success and scrolls
// nothing. The reveal engine is minted here for the same reason
// in a different register — a lane is a row of THIS window, so a second engine would
// publish a second answer for one row's text — and it is disposed with the mount
// that holds this chain.
//
// AND ONE WALK, WHICH IS THE OTHER END OF THE LOG. The store's window begins wherever
// this user's stream was last acknowledged, and everything below that head was
// never delivered — so the ledger reaches it by asking rather than by scrolling.
// `useLedgerEarlierPaging` is that walk, held here because this is where the session
// store is, and handed on to the viewport, where the head control is placed beside
// the tail's.

import { useEffect, useMemo } from "react";

import { consoleLedgerWindows } from "@renderer/lib/transcript-window-diagnostics.js";
import { type ConsoleClock } from "@renderer/lib/clock.js";
import {
  useLedgerEarlierPaging,
  type LedgerEarlierPaging,
} from "../../history/hooks/useEarlierHistory.js";
import { useLedgerFrameCoordinator } from "../../hooks/useAnimationFrameCoordinator.js";
import { useLedgerReveal, type LedgerRevealBinding } from "../../reveal/hooks/useReveal.js";
import {
  useLedgerViewport,
  type LedgerViewportBinding,
} from "../../viewport/hooks/useTranscriptViewport.js";
import {
  deriveDriverAskTerminals,
  type DriverAskReading,
} from "@renderer/console/ledger/cards/index.js";
import {
  useLedgerFilter,
  useFilteredLedgerWindow,
  type LedgerFilterState,
} from "@renderer/console/ledger/pane/find/ledger-narrowing.js";
import {
  useLedgerFirstReadSettled,
  useLedgerProjection,
  useVisibleLedgerWindow,
  type LedgerPipelineStage,
  type LedgerWindowModel,
  type VisibleLedgerWindow,
} from "@renderer/console/ledger/pane/window/index.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import {
  useChapterDisclosure,
  useFoldedChapters,
  type LedgerChapterDisclosure,
} from "@renderer/console/ledger/pane/feed/model/ledger-chapter-fold.js";

/** What the window chain is derived from: the session's store and the frame's clock. */
export interface LedgerFeedWindowsInputs {
  readonly sessionStore: SessionStore;
  /** The frame coordinator's clock, minted once by the mount that holds this chain. */
  readonly clock: ConsoleClock;
}

/**
 * The chain, with every stage's own report beside it.
 *
 * Published as separate members rather than as the last window alone, because the
 * surfaces above read from two different points in it: find classifies an id against
 * every narrowing to say WHICH one is the reason a row is not on screen, and the rows
 * render the folded one.
 */
export interface LedgerFeedWindows {
  readonly firstReadSettled: boolean;
  readonly chapterDisclosure: LedgerChapterDisclosure;
  /** Every member row of every chapter, before any fold or narrowing. */
  readonly unfurledWindow: LedgerWindowModel;
  readonly ledgerFilter: LedgerFilterState;
  readonly narrowing: LedgerPipelineStage;
  readonly chapterFold: LedgerPipelineStage;
  /** The last model window: narrowed and chapter-folded. */
  readonly ledgerWindow: LedgerWindowModel;
  /**
   * The terminal each settled ask in this ledger reached, keyed by run AND ask id.
   *
   * A MEMBER OF THE CHAIN AND NOT OF A WINDOW, which is the whole of the fix. Whether
   * a request still needs answering is a fact about everything this pane is a log of,
   * and every stage below the projection is a NARROWING somebody chose — a facet chip,
   * a folded chapter. A user filter that admits a request row
   * and excludes the row that answered it must not be able to take the terminal with
   * it: the ask would find none, and the card would offer answer controls for an ask
   * the log had already settled. Carried on `LedgerWindowModel` the fold was rebuilt
   * by each of those stages and read off the last of them, which is one spread away
   * from exactly that defect at all times; carried here it is derived once, from the
   * unfurled projection, and no narrowing can reach it.
   *
   * The key belongs to `input-ask.ts` and is never spelled here.
   */
  readonly askTerminalByAskIdentity: ReadonlyMap<string, DriverAskReading>;
  readonly reveal: LedgerRevealBinding;
  readonly viewport: LedgerViewportBinding;
  readonly earlierPaging: LedgerEarlierPaging;
  /** What the viewport reconciled onto the screen, with both absences separable. */
  readonly visible: VisibleLedgerWindow;
}

/** Derive every window this feed draws from, in the one order they may be derived in. */
export function useLedgerFeedWindows(inputs: LedgerFeedWindowsInputs): LedgerFeedWindows {
  // The same reading `<LedgerWindowReadState>` draws its shells from, so the empty
  // sentence and the loading shells cannot both be on screen.
  const firstReadSettled = useLedgerFirstReadSettled(inputs.sessionStore);
  // The fold is the MOUNT's, not the log's: which finished chapters a person has
  // opened is a fact about who is reading, so it is held here and handed to the
  // derivation rather than folded into it.
  const chapterDisclosure = useChapterDisclosure(inputs.sessionStore.sessionId);
  // THE UNFURLED PROJECTION — every member row of every chapter, before any fold.
  const unfurledWindow = useLedgerProjection(inputs.sessionStore);
  // THE NARROWING RUNS ON THAT PROJECTION, BEFORE ANYTHING ELSE SEES IT. Everything
  // below — the chapter fold, the viewport, the visible window and find — is built
  // over the narrowed model, so no piece has to remember that a filter exists.
  //
  // AND THE FOLD RUNS AFTER IT, which is the ordering the filter needs to be
  // truthful at all: folded first, a closed terminal chapter reaches the filter as
  // one receipt, so its messages and tools are
  // unreachable by narrowing until somebody expands the chapter by hand.
  const ledgerFilter = useLedgerFilter(unfurledWindow);
  const narrowing = useFilteredLedgerWindow(unfurledWindow, ledgerFilter.filter);
  const chapterFold = useFoldedChapters(
    narrowing.window,
    chapterDisclosure.openedTerminalRunIds,
    inputs.sessionStore.sessionId,
  );
  const ledgerWindow = chapterFold.window;
  // OVER THE UNFURLED PROJECTION, never over `ledgerWindow`. It is upstream of every
  // narrowing a person can apply, which is what keeps a filtered-away terminal from
  // un-settling a visible request.
  const askTerminalByAskIdentity = useMemo(
    () => deriveDriverAskTerminals(unfurledWindow.rows),
    [unfurledWindow.rows],
  );
  // THE REVEAL ENGINE IS THIS FEED'S, minted once and disposed with it. What it
  // publishes reaches a row through the frame's own channel; what it is DOING reaches
  // the viewport as the drain state, which used to be the literal `false` — a default
  // standing in for a reading of a scheduler nothing had mounted.
  // THE FRAME IS MINTED HERE, above both holders, because that is the only place one
  // object can order the whole paint: phase one is the viewport's scroll writes and
  // phase two is the reveal drain, and a coordinator minted inside either would order
  // that half against nothing.
  const frameCoordinator = useLedgerFrameCoordinator(inputs.clock);
  const reveal = useLedgerReveal({ frameCoordinator });
  const viewport = useLedgerViewport({
    clock: inputs.clock,
    rows: ledgerWindow.viewportRows,
    hasActiveTurn: ledgerWindow.hasActiveTurn,
    isRevealDraining: reveal.isDraining,
  });
  // The walk back past the window's head. Read against the STORE rather than against
  // any of the windows above, because what it can reach is a property of the log this
  // console was given and not of whichever narrowing this pane happens to be applying.
  const earlierPaging = useLedgerEarlierPaging(inputs.sessionStore);

  // WHAT THIS WINDOW IS SHOWING, PUBLISHED FOR A DRIVER PROCESS TO READ. Registered
  // here because this is where the session id and the one binding meet, and gated on
  // the fixture define so a release build registers nothing at all — the reading
  // exists for the endurance tier, which drives a real window from outside the
  // renderer and can otherwise tell "the ledger mounted nothing" from "the ledger has
  // nothing to mount" only by guessing. The reader is stable, so this registers once
  // per mount rather than once per render.
  const readWindowDiagnostics = viewport.readWindowDiagnostics;
  const diagnosticsSessionId = inputs.sessionStore.sessionId;
  useEffect(() => {
    if (!__SIDEKICKS_CONSOLE_FIXTURES__) {
      return;
    }
    return consoleLedgerWindows.register(diagnosticsSessionId, readWindowDiagnostics);
  }, [diagnosticsSessionId, readWindowDiagnostics]);

  // A lane whose row this window no longer holds, or holds only inside a chapter that
  // has reached its terminal, is a turn that is over: the engine drops it so a
  // finished lane stops costing memory. Asked of the engine's own lanes, which are at
  // most one per streaming row — walking the window instead would be a pass over the
  // whole log on every event.
  const retireRevealLanes = reveal.retireLanes;
  useEffect(() => {
    retireRevealLanes(
      (laneId) => !ledgerWindow.rowsByKey.has(laneId) || ledgerWindow.collapsedRowIds.has(laneId),
    );
  }, [retireRevealLanes, ledgerWindow]);

  // Read back off the viewport's own reconciled snapshot, so find is looking at the
  // window on screen rather than at the log behind it. What the cap took is the
  // difference between the two.
  const visible = useVisibleLedgerWindow(ledgerWindow, viewport.snapshot.rows);

  return {
    firstReadSettled,
    chapterDisclosure,
    unfurledWindow,
    ledgerFilter,
    narrowing,
    chapterFold,
    ledgerWindow,
    askTerminalByAskIdentity,
    reveal,
    viewport,
    earlierPaging,
    visible,
  };
}
