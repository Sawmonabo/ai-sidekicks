// The auxiliary-window plane the fixture answers with: which panes are in windows of
// their own, and what the signal that reports a lost one says.
//
// WHY THE FIXTURE IS THE HONEST PLACE FOR THIS, and why serving it is not a
// fabrication. Every other operation the fixture serves stands in for the DAEMON,
// and `fixture-served-operations.ts` states the rule those answers obey: an
// operation is served when a scenario states something it can be answered from.
// These five are addressed to the SHELL rather than to the daemon — the window
// bridge `Spec-023 §Windows` describes — and a scenario carries no windows, so the
// rule as written would refuse all five forever. It also would not be measuring the
// right thing: the fixture bridge stands in for the whole preload surface, and for a
// shell-addressed operation the fixture IS the shell. So the plane below is a real
// model of one, kept per bridge, and every answer it gives is a fact about that
// model rather than a guess about a window somewhere else.
//
// WHAT THAT UNLOCKS, WHICH IS THE POINT. With them all refusing, a hand-off ended at
// its fourth gate under every scenario, screenshot and browser-tier run: no window
// ever opened, so the deck's placeholder, its focus control, its return control, the
// auxiliary window's own return control and the crash note beside them were
// unreachable states of a surface nothing had drawn.
// A surface whose only reachable state is its refusal is the shape
// `fixture-served-operations.ts` names for the agent roster read, and it is this one
// too.
//
// AND WHAT IT DELIBERATELY DOES NOT INVENT. The plane never manufactures a crash. A
// lost window is an OBSERVATION of a process dying, on the health read's own
// reasoning: a fixture that raised one would be asserting a failure that did not
// happen, and every placeholder in every fixture window would carry a note about it.
// The signal is therefore opened, real, and quiet — which is what the daemon's own
// signal delivers for a session whose windows are all alive — and the one act that
// puts a loss on it is {@link FixtureAuxiliaryWindowPlane.reportWindowClosedByShell},
// the shell closing a window out from under the console. That is a thing the shell
// does, so the fixture standing in for the shell is entitled to do it, and it is
// driven rather than spontaneous: nothing in a scenario reaches it.
//
// THE LIVE STATUS DOES NOT MOVE. `window-control-namespace` stays on
// `Plan-023 §Console growth slate` with `wireRegistered: false`, and the live bridge
// goes on refusing every one of them by name. Nothing here is a wire.

import type { GrowthPaneError, GrowthPaneReturn } from "../growth-values/index.js";
import type { GrowthStream } from "../growth-port/growth-outcome.js";
import { growthUnscriptedReply, type GrowthOutcome } from "../growth-port/index.js";
import { FixtureWindowSignalStreams } from "./fixture-window-signal-stream.js";

/** The prefix every window handle this plane mints carries. */
const FIXTURE_WINDOW_ID_PREFIX = "fixture-auxiliary-window";

/**
 * One auxiliary window, as the fixture's shell holds it.
 *
 * The pane is kept beside the handle because both directions are asked: the console
 * addresses focus and close by window, and a loss is reported by PANE — the signal's
 * registered value is a pane id and a reason, since the deck's slot is what has to
 * hear about it.
 */
interface FixtureAuxiliaryWindow {
  readonly windowId: string;
  readonly paneId: string;
}

/**
 * The shell's auxiliary windows, for one fixture bridge.
 *
 * ONE PLANE PER BRIDGE, constructed where the port is. A window handle is meaningful
 * only to the shell that minted it, and a plane shared across bridges would let a
 * scenario switch leave the console holding a handle to a window the new shell has
 * never heard of — which is the state `Spec-023 §Process Model` rules out by giving
 * each window its own bridge instance in the first place.
 */
export class FixtureAuxiliaryWindowPlane {
  readonly #windowByPaneId = new Map<string, FixtureAuxiliaryWindow>();
  readonly #windowById = new Map<string, FixtureAuxiliaryWindow>();
  readonly #paneErrorStreams = new FixtureWindowSignalStreams<GrowthPaneError>();
  readonly #paneReturnStreams = new FixtureWindowSignalStreams<GrowthPaneReturn>();
  #mintedWindowCount = 0;

  /**
   * Move one pane into a window of its own.
   *
   * IDEMPOTENT PER PANE, because the shell it stands in for is: a pane's body cannot
   * be in two windows at once, so a second detach of a pane already in one answers
   * with the window it is already in rather than minting a second handle and orphaning
   * the first. The console's own hand-off does not ask twice; the shell is what makes
   * that safe rather than merely unused.
   *
   * A request naming no pane refuses. There is no window to answer with — the whole
   * subject of the act is missing — and a handle minted for `undefined` would put a
   * placeholder on a slot the deck cannot address.
   */
  public detachPane(request: { readonly paneId: string }): GrowthOutcome<{
    readonly windowId: string;
  }> {
    const paneId = readPaneId(request.paneId);
    if (paneId === undefined) {
      return growthUnscriptedReply("windowDetachPane", "a pane to move into a window");
    }
    const existing = this.#windowByPaneId.get(paneId);
    if (existing !== undefined) {
      return { status: "served", value: { windowId: existing.windowId } };
    }
    this.#mintedWindowCount += 1;
    const opened: FixtureAuxiliaryWindow = {
      windowId: `${FIXTURE_WINDOW_ID_PREFIX}-${String(this.#mintedWindowCount)}`,
      paneId,
    };
    this.#windowByPaneId.set(paneId, opened);
    this.#windowById.set(opened.windowId, opened);
    return { status: "served", value: { windowId: opened.windowId } };
  }

  /**
   * Bring one window forward.
   *
   * Served for a window this plane opened and refuses for any other handle, which is
   * the same disposition the subject-addressed workflow reads take: a fixture that
   * answered for a window it has never held would be reporting an act it did not
   * perform, and the console would render a focus that never happened.
   */
  public focusAuxiliary(request: { readonly windowId: string }): GrowthOutcome<void> {
    if (!this.#windowById.has(request.windowId)) {
      return growthUnscriptedReply("windowFocusAuxiliary", "a window by that handle");
    }
    return { status: "served", value: undefined };
  }

  /**
   * Close one window, returning its pane to the deck.
   *
   * NO LOSS IS REPORTED, and that is the distinction the two signals exist for: a
   * window the console closed came back because somebody asked, and putting that on
   * the crashed-window signal would tell the deck a pane returned unexpectedly when it
   * did not. It goes on the RETURN signal instead, and unconditionally — including
   * when the deck itself asked, where the report reaches a deck that has already
   * restored the slot and does nothing. Reporting only the window's own closes would
   * make the shell's account of a window depend on who asked, which is exactly the
   * fact the shell is the authority on and the console is not.
   */
  public closeAuxiliary(request: { readonly windowId: string }): GrowthOutcome<void> {
    const open = this.#windowById.get(request.windowId);
    if (open === undefined) {
      return growthUnscriptedReply("windowCloseAuxiliary", "a window by that handle");
    }
    this.#forget(open);
    this.#paneReturnStreams.report({ windowId: open.windowId, paneId: open.paneId });
    return { status: "served", value: undefined };
  }

  /**
   * Open the crashed-window signal.
   *
   * Always served, and quiet until something is lost. The subscription is what the
   * console holds while any pane is in a window of its own, and a refusal here would
   * sit in the placeholder as a permanent notice about a hazard the window does not
   * have — which is the reading `aux-pane-error-watch.ts` was written under.
   */
  public subscribePaneErrors(): GrowthOutcome<GrowthStream<GrowthPaneError>> {
    return { status: "served", value: this.#paneErrorStreams.subscribe() };
  }

  /**
   * Open the orderly-return signal.
   *
   * Served on the same terms as the crash signal beside it, and quiet for the same
   * reason: it reports acts, and until a window is closed there have been none. Its
   * producer is {@link closeAuxiliary} rather than an act of this module's own —
   * which is the whole distinction between the two signals. A loss has to be DRIVEN
   * because nothing in a scenario crashes a window; a return needs no such act,
   * because closing a window is an ordinary operation the console itself performs
   * and the shell is entitled to report.
   */
  public subscribePaneReturns(): GrowthOutcome<GrowthStream<GrowthPaneReturn>> {
    return { status: "served", value: this.#paneReturnStreams.subscribe() };
  }

  /**
   * The shell closed a window the console still believes is open.
   *
   * THE ONE PRODUCER OF A LOSS, and it is driven rather than spontaneous. `Spec-023
   * §The surface set` requires a crashed auxiliary window to return its pane to the
   * deck with the crash noted in the pane's error slot, and nothing in a fixture
   * scenario crashes anything — so without an act that says it happened, that whole
   * arm is a state no fixture-driven surface can enter. This is that act: the fixture
   * standing in for the shell, doing the one thing to a window that a shell does and
   * a scenario cannot.
   *
   * Answers whether there was such a window, so a caller driving the arm cannot
   * mistake a handle it mistyped for a loss the console ignored.
   */
  public reportWindowClosedByShell(windowId: string, reason: string): boolean {
    const open = this.#windowById.get(windowId);
    if (open === undefined) {
      return false;
    }
    this.#forget(open);
    this.#paneErrorStreams.report({ paneId: open.paneId, reason });
    return true;
  }

  #forget(window: FixtureAuxiliaryWindow): void {
    this.#windowById.delete(window.windowId);
    this.#windowByPaneId.delete(window.paneId);
  }
}

/**
 * The pane a hand-off names, or `undefined` where it named none.
 *
 * Blank is treated as absent rather than as a name: a pane id is a key the deck
 * addresses a slot by, and whitespace is not one. The request's type says `string`,
 * and the sweep in `fixture-growth-port.test.ts` calls every served operation with
 * one request shape — so the value this reads is genuinely `undefined` at runtime for
 * an operation addressed by something else, which the type alone would not admit.
 */
function readPaneId(candidate: string | undefined): string | undefined {
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}
