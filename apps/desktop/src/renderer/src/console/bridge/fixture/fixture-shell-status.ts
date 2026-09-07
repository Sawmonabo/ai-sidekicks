// The shell's own condition, answered from the scenario the fixture is playing.
//
// WHY IT IS HERE. `index.ts` beside this file states the rule — a module that exists
// so the fixture can ANSWER something belongs in this directory — and this is the
// first such answer that is a FEED rather than a reply. The roster read next door is
// the closest neighbour and the two are deliberately the same shape at rest: both
// read a list of frames the scenario declares against the frozen clock's elapsed
// time, and neither invents a value for a scenario that names none.
//
// WHAT WAKES IT. The console's own rule forbids interval polling, and the fixture has
// no clock of its own to poll anyway: the frozen clock moves only when a caller
// advances the engine. So this stream wakes on the engine's OWN beat subscription —
// the one signal that says the clock has moved — recomputes which frame is due, and
// yields it only when it differs from the last one it sent. A scenario whose shell
// frames sit at ticks no beat is due at will therefore not wake on its own, which is
// stated here rather than papered over: a scenario places its shell frames on beat
// ticks, and `shell.ts` beside it does.
//
// AND IT IS ONE CHANNEL, NOT FOUR. The feed and the three daemon controls answer
// about the same shell, so a stop that did not move what the feed says would be a
// fixture teaching every surface above it that a control can be pressed and change
// nothing. The channel below owns the current report; the frames drive it and the
// controls override it, and an override wins because it happened later.
//
// WHICH IS WHY "LATER" IS MEASURED AND NOT ASSUMED. An override used to win forever:
// `current()` answered it before it ever looked at the clock, so the first control a
// person pressed silenced the rest of the script — a restart published `starting` and
// the scenario's own eventual `connected` could never be emitted, leaving the frame
// reconnecting for the whole run. The override is therefore STAMPED with the scenario
// time it was published at, and a scripted frame that falls due after that stamp is
// the scenario speaking later still and takes the channel back. The stamp is kept
// rather than cleared once it has been superseded: the frozen clock only ever moves
// forward, so a superseded override can never win again, and clearing it would make
// `current()` a read that writes.
//
// WHAT A CONTROL NEVER DOES IS CLAIM IT WORKED. Restart and start publish
// `starting` and stop there. The supervisor's next report is what says the runtime
// came back, and a fixture that jumped to `connected` would train the console
// against the one synthesis the design forbids.
//
// WHAT IT NEVER DOES. It never synthesises a report. A scenario that declares no
// frames refuses through the port's own "not checked" absence, because a fixture
// answering "connected" for a shell nobody scripted would train every surface above
// it against a state the live bridge can never produce. That absence is the
// SCENARIO's and never the build's — this port implements the feed — so it takes the
// unscripted refusal, and `SHELL_STATUS_SCRIPT` below is what the sentence names as
// missing.

import { shellReportsAreEqual, type ShellReport } from "../../store/index.js";
import type { GrowthStream } from "../growth-port/growth-outcome.js";
import type { ScenarioEngine, ScenarioShellStatusFrame } from "../scenario-runtime/index.js";

/**
 * What a scenario declares to give this feed something to answer with.
 *
 * The unscripted refusal names the missing CALL, and nothing here is reached by a
 * call: the four operations read frames a scenario declares on its own field. So the
 * name a reader is sent to is that field rather than a wire method, which would name
 * a call no scenario makes and send an author looking for a reply to write.
 */
export const SHELL_STATUS_SCRIPT: string = "shellStatus";

/**
 * The frame current at an elapsed tick, or `undefined` before the first one is due.
 *
 * The roster reader's own rule, and the same reasoning: frames are declared in tick
 * order and the current one is the last that has fallen due, so a scenario whose
 * first frame lands at tick 200 has an unanswered shell condition until then rather
 * than a fabricated one.
 */
function frameDueAt(
  frames: readonly ScenarioShellStatusFrame[],
  elapsedMs: number,
): ScenarioShellStatusFrame | undefined {
  let current: ScenarioShellStatusFrame | undefined;
  for (const frame of frames) {
    if (frame.atMs > elapsedMs) {
      break;
    }
    current = frame;
  }
  return current;
}

/**
 * A report a control published, and the scenario tick it was published at.
 *
 * The stamp is the whole of what makes an override supersedable. Without it the
 * channel holds a report with no place in the scenario's own order, and the only
 * comparison left — "is there an override?" — answers yes forever.
 */
interface StampedShellOverride {
  readonly report: ShellReport;
  readonly publishedAtMs: number;
}

/**
 * The shell's condition for one running fixture port, and the controls that move it.
 *
 * A class rather than a closure over a `let`, because it owns three things that have
 * to agree: the current report, the engine subscription that advances it, and the
 * open streams that have to be woken when either moves. One instance per port, so a
 * control pressed in one window cannot move another window's shell.
 */
export class FixtureShellChannel {
  readonly #engine: ScenarioEngine;
  readonly #listeners = new Set<() => void>();
  #engineRelease: (() => void) | undefined;
  #override: StampedShellOverride | undefined;

  public constructor(engine: ScenarioEngine) {
    this.#engine = engine;
  }

  /** Whether the scenario declares a shell condition at all. */
  public get isScripted(): boolean {
    const frames = this.#engine.scenario.shellStatus;
    return frames !== undefined && frames.length > 0;
  }

  /**
   * What the shell is saying now, or `undefined` before anything has been said.
   *
   * The scripted frame is resolved FIRST and the override is compared against it,
   * rather than the other way round: an override that short-circuits the clock is an
   * override the script can never answer. A frame due strictly after the stamp is the
   * scenario speaking later than the control did; one due at or before it is the state
   * the control replaced, so `>` and not `>=` — a control pressed on the same tick as
   * a frame still happened after that frame became current.
   */
  public current(): ShellReport | undefined {
    const frames = this.#engine.scenario.shellStatus ?? [];
    const scriptedFrame = frameDueAt(frames, this.#engine.progress.elapsedMs);
    const override = this.#override;
    if (override === undefined) {
      return scriptedFrame?.report;
    }
    return scriptedFrame !== undefined && scriptedFrame.atMs > override.publishedAtMs
      ? scriptedFrame.report
      : override.report;
  }

  /** Publish a report a control produced, stamped with now. Wakes every open stream. */
  public publish(report: ShellReport): void {
    this.#override = { report, publishedAtMs: this.#engine.progress.elapsedMs };
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }

  /**
   * Open a feed, or answer `undefined` where the scenario scripts none.
   *
   * `undefined` is the caller's signal to refuse by name rather than to serve an
   * empty stream: a stream that opens and never yields is indistinguishable, on
   * screen, from a shell that has not reported — and one of those is a scripting gap
   * the author can fix while the other is the console's ordinary state.
   */
  public open(): GrowthStream<ShellReport> | undefined {
    return this.isScripted ? new ChannelShellStatusStream(this) : undefined;
  }

  /**
   * Watch for a change, binding the engine on the first watcher and releasing it
   * with the last.
   *
   * Lazy rather than bound in the constructor: a port whose scenario never opens the
   * feed and never presses a control holds no subscription at all, which is what
   * keeps a fixture window that renders no shell chrome free of the beat traffic.
   */
  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    this.#engineRelease ??= this.#engine.subscribe(() => {
      for (const each of [...this.#listeners]) {
        each();
      }
    });
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#engineRelease?.();
        this.#engineRelease = undefined;
      }
    };
  }
}

/**
 * One consumer's view of the channel.
 *
 * A class rather than a bare async generator because it owns two things a generator
 * cannot: the channel subscription that wakes it, and the single-slot buffer that
 * keeps a fast-advancing scenario from queueing one report per beat. Latest wins in
 * that slot — a consumer that renders the shell's condition wants the CURRENT one,
 * and a queue of superseded reports would paint a reconnect ladder that had already
 * finished.
 */
class ChannelShellStatusStream implements GrowthStream<ShellReport> {
  readonly #channel: FixtureShellChannel;
  #release: (() => void) | undefined;
  #pending: ShellReport | undefined;
  #lastSent: ShellReport | undefined;
  #wake: (() => void) | undefined;
  #closed = false;

  public constructor(channel: FixtureShellChannel) {
    this.#channel = channel;
    this.#release = channel.subscribe(() => {
      this.#offerCurrent();
    });
    this.#offerCurrent();
  }

  public get events(): AsyncIterable<ShellReport> {
    return this.#iterate();
  }

  /** Terminal. Releases the channel subscription and ends the iteration. */
  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#release?.();
    this.#release = undefined;
    this.#wake?.();
    this.#wake = undefined;
  }

  #offerCurrent(): void {
    if (this.#closed) {
      return;
    }
    const report = this.#channel.current();
    if (report === undefined) {
      return;
    }
    if (this.#lastSent !== undefined && shellReportsAreEqual(this.#lastSent, report)) {
      return;
    }
    this.#pending = report;
    this.#wake?.();
    this.#wake = undefined;
  }

  async *#iterate(): AsyncGenerator<ShellReport> {
    while (!this.#closed) {
      const pending = this.#pending;
      if (pending !== undefined) {
        this.#pending = undefined;
        this.#lastSent = pending;
        yield pending;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

/** The report a stop produces: the shell as it was, deliberately turned off. */
export function stoppedReport(current: ShellReport): ShellReport {
  return { ...current, connection: { kind: "stopped" } };
}

/** The report a start or a restart produces. Never `connected`. */
export function startingReport(current: ShellReport): ShellReport {
  return { ...current, connection: { kind: "starting" } };
}
