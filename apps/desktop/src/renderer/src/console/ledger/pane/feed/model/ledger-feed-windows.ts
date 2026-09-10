// Every window this feed derives, in the one order they may be derived in.
//
// WHAT THIS MODULE OWNS. A ledger pane holds a chain of windows, not one: the whole
// unfurled projection, the same projection narrowed by the facet bar, that narrowing
// with finished chapters folded, that fold with rewound bands folded, and finally the
// part the viewport reconciled onto the screen. Each stage is somebody else's
// derivation — `ledger-window.ts`', `ledger-narrowing.ts`', `ledger-chapter-fold.ts`',
// `ledger-superseded-fold.ts`', `viewport-binding.ts`', `ledger-visible-window.ts`' —
// and what this module adds is the ORDER and nothing else. It folds no log, measures
// no row and writes no `scrollTop`.
//
// WHY THE ORDER IS THE PRODUCT. Three of the stages are only truthful in one
// position, and the reasons are stated at each call below: the narrowing runs on the
// unfurled projection so no piece downstream has to remember a filter exists, the
// chapter fold runs AFTER the narrowing or a closed terminal chapter reaches the
// filter as one receipt, and the band fold runs after the chapter fold because a
// folded chapter has already reduced itself to a header and a receipt. A caller that
// composed these stages itself would be free to get that wrong, and the failure is
// silent: every ordering renders rows.
//
// AND WHY EACH STAGE'S OWN REPORT LEAVES WITH IT. The three counts beside the find
// field are made of exactly these separations — a match the cap took, one the facet
// bar is hiding, one a folded chapter holds are three states with three different
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
// this participant's stream was last acknowledged, and everything below that head was
// never delivered — so the ledger reaches it by asking rather than by scrolling.
// `useLedgerEarlierPaging` is that walk, held here because this is where the session
// store is, and handed on to the viewport, where the head control is placed beside
// the tail's.

import { useEffect, useMemo } from "react";

import { consoleLedgerWindows, type ConsoleClock } from "../../../../core/index.js";
import {
  useLedgerEarlierPaging,
  useLedgerFrameCoordinator,
  useLedgerReveal,
  useLedgerViewport,
  type LedgerEarlierPaging,
  type LedgerRevealBinding,
  type LedgerViewportBinding,
} from "../../../frame/index.js";
import { deriveDriverAskTerminals, type DriverAskReading } from "../../../cards/index.js";
import {
  useChildRunDisclosure,
  type ChildRunDisclosure,
} from "../../../structure/child-runs/index.js";
import {
  useLedgerFilter,
  useFilteredLedgerWindow,
  type LedgerFilterState,
} from "../../find/index.js";
import {
  useLedgerFirstReadSettled,
  useLedgerProjection,
  useVisibleLedgerWindow,
  type LedgerPipelineStage,
  type LedgerWindowModel,
  type VisibleLedgerWindow,
} from "../../window/index.js";
import { usePeerInvocationProjection, type SessionStore } from "../../../../store/index.js";
import {
  useChapterDisclosure,
  useFoldedChapters,
  type LedgerChapterDisclosure,
} from "./ledger-chapter-fold.js";
import {
  useFoldedSupersededBands,
  useSupersededBandDisclosure,
  type LedgerSupersededBandDisclosure,
} from "./ledger-superseded-fold.js";

export interface LedgerFeedWindowsInputs {
  readonly sessionStore: SessionStore;
  /** The channel this feed is a log OF, or absent for the whole session. */
  readonly channelId?: string | undefined;
  /** The frame coordinator's clock, minted once by the mount that holds this chain. */
  readonly clock: ConsoleClock;
}

/**
 * The chain, with every stage's own report beside it.
 *
 * Published as separate members rather than as the last window alone, because the
 * surfaces above read from three different points in it: the facet bar offers facets
 * derived from the whole unfurled projection (or admitting one participant would take
 * away the chip that widens back), find classifies an id against every narrowing to
 * say WHICH one is the reason a row is not on screen, and the rows render the folded
 * one.
 */
export interface LedgerFeedWindows {
  /**
   * Whether this session's sidekicks may reach each other. Subscribed, not latched.
   *
   * `undefined` where nothing has been projected yet, which is a third state and not
   * a false: the empty window says something different about a session whose grant is
   * off from one whose grant has not been read.
   */
  readonly peerInvocationEnabled: boolean | undefined;
  readonly firstReadSettled: boolean;
  readonly chapterDisclosure: LedgerChapterDisclosure;
  readonly childRunDisclosure: ChildRunDisclosure;
  readonly supersededBandDisclosure: LedgerSupersededBandDisclosure;
  /** Every member row of every chapter, before any fold or narrowing. */
  readonly unfurledWindow: LedgerWindowModel;
  readonly ledgerFilter: LedgerFilterState;
  readonly narrowing: LedgerPipelineStage;
  readonly chapterFold: LedgerPipelineStage;
  readonly bandFold: LedgerPipelineStage;
  /** The last model window: narrowed, chapter-folded, band-folded. */
  readonly ledgerWindow: LedgerWindowModel;
  /**
   * The terminal each settled ask in this ledger reached, keyed by run AND ask id.
   *
   * A MEMBER OF THE CHAIN AND NOT OF A WINDOW, which is the whole of the fix. Whether
   * a request still needs answering is a fact about everything this pane is a log of,
   * and every stage below the projection is a NARROWING somebody chose — a facet chip,
   * a folded chapter, a folded band. A participant filter that admits a request row
   * and excludes the row that answered it must not be able to take the terminal with
   * it: the ask would find none, and the card would offer answer controls for an ask
   * the log had already settled. Carried on `LedgerWindowModel` the fold was rebuilt
   * by each of those stages and read off the last of them, which is one spread away
   * from exactly that defect at all times; carried here it is derived once, from the
   * unfurled channel-scoped projection, and no narrowing can reach it.
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

export function useLedgerFeedWindows(inputs: LedgerFeedWindowsInputs): LedgerFeedWindows {
  // WHY THE GRANT IS READ HERE. A session whose sidekicks may not reach each other
  // produces no handoff row at all — every peer invocation is adjudicated per call
  // against this projected member and answers denied — so an empty log in such a
  // session is not the absence of activity it reads as. The empty window says so,
  // and this chain holds the store to read it from. Subscribed rather than read
  // once: the grant is a durable session fact anybody in the session can change, and
  // a value latched at mount would keep saying so after it was turned on.
  const peerInvocation = usePeerInvocationProjection(inputs.sessionStore);
  // The same reading `<LedgerWindowReadState>` draws its shells from, so the empty
  // sentence and the loading shells cannot both be on screen.
  const firstReadSettled = useLedgerFirstReadSettled(inputs.sessionStore);
  // The fold is the MOUNT's, not the log's: which finished chapters a person has
  // opened is a fact about who is reading, so it is held here and handed to the
  // derivation rather than folded into it.
  const chapterDisclosure = useChapterDisclosure(inputs.sessionStore.sessionId);
  // Held beside the chapter's, at the same scope and for the same reason: a mount
  // that followed a navigation would otherwise carry one session's expansions into
  // the next one's rows.
  const childRunDisclosure = useChildRunDisclosure(inputs.sessionStore.sessionId);
  // And beside both, at the same scope: which rewound bands this reader has folded
  // away. It starts empty on purpose — a band is dimmed and present until somebody
  // asks for it to be folded, which is the rule `superseded-bands.ts` states.
  const supersededBandDisclosure = useSupersededBandDisclosure(inputs.sessionStore.sessionId);
  // THE UNFURLED PROJECTION — every member row of every chapter, before any fold.
  const unfurledWindow = useLedgerProjection(inputs.sessionStore, inputs.channelId);
  // THE NARROWING RUNS ON THAT PROJECTION, BEFORE ANYTHING ELSE SEES IT. Everything
  // below — the chapter fold, the viewport, the visible window and find — is built
  // over the narrowed model, so no piece has to remember that a filter exists. The
  // facets the bar offers are the exception, and deliberately so: they are derived
  // from the WHOLE unfurled projection, or admitting one participant would take away
  // the chip that widens back.
  //
  // AND THE FOLD RUNS AFTER IT, which is the ordering the filter needs to be
  // truthful at all: folded first, a closed terminal chapter reaches the filter as
  // one receipt, so its messages and tools are absent from the facet counts and
  // unreachable by narrowing until somebody expands the chapter by hand.
  const ledgerFilter = useLedgerFilter(unfurledWindow);
  const narrowing = useFilteredLedgerWindow(unfurledWindow, ledgerFilter.filter);
  const chapterFold = useFoldedChapters(
    narrowing.window,
    chapterDisclosure.openedTerminalRunIds,
    inputs.sessionStore.sessionId,
  );
  // AND THE BAND FOLD RUNS AFTER THE CHAPTER'S, so a folded chapter has already
  // reduced itself to a header and a receipt and there is nothing left in it for this
  // pass to hide a second time.
  const bandFold = useFoldedSupersededBands(
    chapterFold.window,
    supersededBandDisclosure.foldedBandKeys,
    inputs.sessionStore.sessionId,
  );
  const ledgerWindow = bandFold.window;
  // OVER THE UNFURLED PROJECTION, never over `ledgerWindow`. It is channel-scoped
  // already — so an ask settled in another channel's log does not silence a request
  // this pane is showing — and it is upstream of every narrowing a person can apply,
  // which is what keeps a filtered-away terminal from un-settling a visible request.
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
    peerInvocationEnabled: peerInvocation.enabled,
    firstReadSettled,
    chapterDisclosure,
    childRunDisclosure,
    supersededBandDisclosure,
    unfurledWindow,
    ledgerFilter,
    narrowing,
    chapterFold,
    bandFold,
    ledgerWindow,
    askTerminalByAskIdentity,
    reveal,
    viewport,
    earlierPaging,
    visible,
  };
}
