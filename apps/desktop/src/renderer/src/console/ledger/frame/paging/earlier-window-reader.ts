// Reaching the rows BEFORE the window this console was given.
//
// WHY THERE IS ANYTHING TO REACH. A session's stream replays from the position this
// user was last acknowledged at, so a resumed read establishes a window whose
// head is somewhere in the middle of the log. Everything below that head exists, was
// never delivered, and is unreachable by scrolling: the store appends at the tail and
// the viewport prunes toward it, so no amount of reading moves the head. One
// registered call moves it — `timeline.read` carrying `beforeCursor` — and this is the
// object that decides when to send it and what to do with the answer.
//
// WHAT IT IS NOT. It is not a second window model, and it holds no rows: the page it
// reads goes straight into the session store's own log through
// `prependEarlierEvents`, which is the one door a log grows at its head through. What
// this object holds is a POSITION and a verdict — where the next page starts, and
// whether the producer said any remain.
//
// THE VERDICT IS THE PRODUCER'S. `hasMore` is required on both arms of the registered
// response, so "are there earlier rows" is an answer the daemon gave rather than a
// fact inferred from a page arriving full, from a page arriving short, or from a
// cursor's absence. The one thing read locally is whether a cursor came back at all —
// without one there is nowhere to ask from, whatever the reply claims remains.
//
// SINGLE-FLIGHT, AND LOCAL. A second press while a page is in flight is dropped
// rather than queued: the control is a button a person can press repeatedly, and two
// backward reads from one cursor fetch the same rows twice and then merge one of them
// into a log that already holds it. The exclusion is a field here rather than the
// collaboration family's wire-mutation coordinator, and that is a DAG fact rather than
// a preference — `console-view-family-isolation` forbids one view family importing
// another, so a ledger read cannot reach a coordinator that lives in `collaboration/`,
// and the refusals that coordinator raises name that family as their origin.
//
// AND A PAGE CAN OUTLIVE THE WINDOW IT WAS ADDRESSED FROM. A refresh re-establishes
// the store's base state while a backward read is in flight, and the page that then
// arrives names rows before a head the store has already left. Merging it is not
// merely stale, it is UNRECOVERABLE: those rows land in front of the new window's
// oldest row, the log's head sequence moves down to them, and every later page — the
// ones that would have filled the interval between the two heads — is then refused by
// the store's own strictly-earlier guard as not earlier than a row that should never
// have been there. Nothing this object does afterwards can take them out again, since
// the log grows at its head and shrinks at neither end. So the page is DISCARDED,
// which costs one round trip and leaves the walk free to re-ask from the head the
// store now has. What it is measured against is the STORE's window generation rather
// than a cursor compared here: a read that re-established the SAME position still
// threw the old log away, and a page admitted across that boundary opens exactly the
// same hole.
//
// AND THE READ IS SESSION-SCOPED EVEN IN A CHANNEL PANE. `TimelineReadRequest` carries
// a `channelId` filter and this deliberately never sends one: the store's log is the
// SESSION's, and the channel narrowing is applied above it by the pane's own
// projection. A filtered backward page would put a channel-only prefix in front of an
// unfiltered tail, so every other narrowing in that pane — the facets, the chapters,
// find's four counts — would be reading a log that is two different things at two
// ends.

import { type EventCursor, type SessionId } from "@ai-sidekicks/contracts";

import { LEDGER_EARLIER_PAGE_ROWS, type ConsoleRefusal } from "../../../core/index.js";
import { callDaemon, readEarlierTimelinePage, type ConsoleBridge } from "../../../bridge/index.js";
import {
  isReadAbandoned,
  ReadScope,
  type CurrentGenerationClaim,
  type SessionStore,
} from "../../../store/index.js";

/** What a surface renders about the rows before this window. */
export interface LedgerEarlierWindowState {
  /**
   * Whether a backward page can be asked for right now.
   *
   * False for three different reasons, and the surface deliberately does not tell
   * them apart: the window opens at the beginning of the log, the producer has said
   * nothing remains, or a page is already in flight. All three mean the same thing to
   * a person looking at the control — there is nothing to press — and the third is
   * carried separately as {@link isReading} for the ones that render progress.
   */
  readonly canLoadEarlier: boolean;
  /** A backward page is in flight. */
  readonly isReading: boolean;
  /** Why the last attempt did not land, until the next one is made. */
  readonly refusal: ConsoleRefusal | undefined;
  /** Rows this walk has admitted at the head, across every page it has read. */
  readonly admittedRowCount: number;
}

/**
 * One session's backward walk.
 *
 * A class with private fields per `apps/desktop/AGENTS.md`: this is state with an act
 * that changes it, and the act has to be able to refuse without every caller
 * remembering the single-flight rule.
 */
export class LedgerEarlierWindowReader {
  /**
   * The store window this walk is based on, once one has been observed.
   *
   * The store's own claim rather than a copy of its head cursor, because the claim is
   * re-taken by the one act that moves a window — a completed read re-establishing the
   * base state — whichever position that read was performed from.
   */
  #baseWindowGeneration: CurrentGenerationClaim | undefined;
  /**
   * The line every backward page is read on, and the one thing that can stop one.
   *
   * OWNED HERE RATHER THAN TAKEN FROM THE PRESS, because the round has to be opened
   * AFTER the single-flight guard has admitted the press: a round opened by the caller
   * would abort the page already in flight on exactly the double press this walk drops,
   * and the reader would then install the door's own `read-abandoned` refusal beside a
   * control that had done nothing wrong. The walk's owner ends the line through
   * {@link abandonReads}, which is what `paging-binding.ts` hands the holder as its
   * disposal — so a pane that leaves stops its outstanding page rather than only
   * ignoring it.
   */
  readonly #readLine = new ReadScope();
  /** Where the next page starts. `undefined` means there is nowhere to ask from. */
  #nextBeforeCursor: string | undefined;
  #exhausted = true;
  #isReading = false;
  #refusal: ConsoleRefusal | undefined;
  #admittedRowCount = 0;

  /** Whether this walk's read line is over. True once and never false again. */
  public get isAbandoned(): boolean {
    return this.#readLine.isAbandoned;
  }

  /**
   * End the read line: an outstanding page stops, and no later one is live.
   *
   * The walk's own fields are left exactly as they stand. A holder that hands this
   * reader back — React's double-mount does — is handed a corpse its `isClosed`
   * reading recognises, and a fresh reader is minted rather than this one revived.
   */
  public abandonReads(): void {
    this.#readLine.abandon();
  }

  /**
   * What a surface should render, read against the store as it stands.
   *
   * The store is passed in rather than held because the walk's base is a fact the
   * STORE owns — a completed read re-establishes where the window starts — and an
   * object holding its own copy would keep walking from a head the store had moved.
   */
  public state(sessionStore: SessionStore): LedgerEarlierWindowState {
    this.#rebaseIfWindowMoved(sessionStore);
    return {
      canLoadEarlier: !this.#exhausted && !this.#isReading && this.#nextBeforeCursor !== undefined,
      isReading: this.#isReading,
      refusal: this.#refusal,
      admittedRowCount: this.#admittedRowCount,
    };
  }

  /**
   * Read one page of rows before this window's head and grow the log with it.
   *
   * Resolves when the page has landed or been refused; the caller re-reads
   * {@link state} either way. Never rejects — `callDaemon` answers `served` or
   * `refused` for every outcome a transport can have, so there is no arm here for an
   * exception and no `catch` holding a code nothing can render.
   */
  public async loadEarlier(bridge: ConsoleBridge, sessionStore: SessionStore): Promise<void> {
    const baseWindowGeneration = this.#rebaseIfWindowMoved(sessionStore);
    const beforeCursor = this.#nextBeforeCursor;
    if (this.#isReading || this.#exhausted || beforeCursor === undefined) {
      return;
    }
    this.#isReading = true;
    this.#refusal = undefined;
    const round = this.#readLine.openRound();
    try {
      const reply = await callDaemon(
        bridge,
        "timeline.read",
        {
          // BOTH BRANDS ARE FORWARDED, NEVER MINTED. `SessionId` and `EventCursor` are
          // compile-time markers over opaque wire strings, and both of these values
          // came off the wire: the id is the one the store was opened under, and the
          // cursor is whatever the daemon last issued. `repos/repo-reads.ts` re-narrows
          // the first the same way and for the same reason, and the two casts stay
          // local because a view family may import no other view family.
          sessionId: sessionStore.sessionId as SessionId,
          beforeCursor: beforeCursor as EventCursor,
          limit: LEDGER_EARLIER_PAGE_ROWS,
        },
        { signal: round.signal },
      );
      if (isReadAbandoned(round.signal)) {
        // NOTHING IS WAITING, so nothing installs — not the page and not the refusal
        // the door composes for an abandoned read. The reading is taken here rather
        // than left to the window generation because the two answer different
        // questions: that one says the window moved under this page, and this one says
        // there is no longer a surface offering the control the page was pressed on.
        return;
      }
      if (reply.status === "refused") {
        // Through the round as well, and for the same reason the page is: a refusal
        // installed after the window moved is a failure reported against a read the
        // surface is no longer offering, on a control the rebase has already re-armed.
        baseWindowGeneration.settle(() => {
          this.#refusal = reply.refusal;
        });
        return;
      }
      const page = readEarlierTimelinePage(reply.value);
      // THE ROWS GO TO THE STORE AND THE POSITION STAYS HERE. The merge answers how
      // many it admitted, which is what makes a page the log already held visible as
      // a page that added nothing rather than as a press that did nothing.
      //
      // AND BOTH INSTALL ONLY WHILE THIS PAGE'S WINDOW IS STILL THE STORE'S. Settling
      // through the round covers the position as well as the rows on purpose — a walk
      // carried into a window it was not measured in would go on asking from a cursor
      // that names the old head, which is the same hole reached one press later.
      baseWindowGeneration.settle(() => {
        this.#admittedRowCount += sessionStore.prependEarlierEvents(page.events).admitted;
        this.#nextBeforeCursor = page.nextBeforeCursor;
        this.#exhausted = !page.hasEarlierRows || page.nextBeforeCursor === undefined;
      });
    } finally {
      this.#isReading = false;
    }
  }

  /**
   * Start the walk over when the store's window is no longer the one it was based on,
   * and answer the window generation it is based on now.
   *
   * ONE SIGNAL, AND IT IS THE ACT ITSELF. A window moves in two ways that look
   * different from outside: a completed read that acknowledged a different position
   * gives a different head, and one that acknowledged the SAME position still threw
   * the old log away and dropped whatever a backward walk had put in front of it.
   * Both are the store re-establishing its base state, which is exactly what re-takes
   * its window generation — so one comparison covers both, and covers them at the
   * moment the window moved rather than after a page has already landed in the wrong
   * one. It is answered rather than only stored, because the caller that issues a read
   * has to hold the generation it was issued under until the reply lands.
   */
  #rebaseIfWindowMoved(sessionStore: SessionStore): CurrentGenerationClaim {
    const baseWindowGeneration = this.#baseWindowGeneration;
    if (baseWindowGeneration?.isCurrent === true) {
      return baseWindowGeneration;
    }
    const windowGeneration = sessionStore.windowGeneration;
    const windowHeadCursor = sessionStore.snapshot().windowHeadCursor;
    this.#baseWindowGeneration = windowGeneration;
    this.#nextBeforeCursor = windowHeadCursor;
    // A window that opens at the beginning of the log has nothing before it, which is
    // exhausted in the only sense the control cares about: there is nothing to press
    // for. It is not a refusal and it is not a failure — it is a first read.
    this.#exhausted = windowHeadCursor === undefined;
    this.#refusal = undefined;
    this.#admittedRowCount = 0;
    return windowGeneration;
  }
}
