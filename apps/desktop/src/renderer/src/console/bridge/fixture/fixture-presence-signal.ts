// The session's Awareness subscription, served from the scenario.
//
// WHAT WAS WRONG. `presence.subscribe` is a registered `daemon.subscribe` name, and
// the fixture's subscription door knew three stream names and treated every other one
// as a bare EVENT TYPE. So a subscriber that named this one was matched against the
// kind `presence.subscribe`, which no census registers and no scenario plays, and was
// handed nothing for the life of the window. Two console surfaces subscribe to it —
// the roster and the activity feed — and both are push-driven reads, so neither ever
// re-read: the roster answered once at mount, and the activity feed rendered the frame
// that happened to be due when it opened and no later one, whatever the script said.
// A scenario that scripts a person to stop typing at half a second showed them typing
// forever, and every capture and end-to-end result taken against it looked like a pass.
//
// SO THE SUBSCRIPTION IS SERVED BY ITS OWN SEMANTICS, WHICH ARE NOT AN EVENT KIND'S.
// The read is the truth and the push is only a signal: what reaches a subscriber is
// that the room MOVED, carrying nothing it opens, and the reading comes from the room's
// own read. That makes the question this module answers "when did the room move", and
// the room has two halves the console's own vocabulary already separates:
//
//   • Somebody's PRESENCE transitioned, which is a `presence.*` beat on the session
//     log. Which kinds those are is the stream table's answer and never a second
//     reading taken here — the row carries them, and this module is handed the row.
//   • What somebody is DOING changed, which is an activity frame falling due. The
//     census registers no event for composing at all — it rides beside presence rather
//     than inside it — so no beat can carry this half and a signal that watched only
//     the log would be silent for exactly the frames a scenario schedules.
//
// The second half hangs off scenario ADVANCEMENT, which is the one thing that moves
// the frozen clock, and it asks `fixture-activity.ts`'s own due rule rather than a copy
// of it: the signal fires when the frame the READ would now serve is a different one.
// Nothing here polls and nothing arms a timer — a fixture that armed one would be a
// second clock, which is what the engine exists to prevent.
//
// AND A SIGNAL IS A MOMENT, SO THERE IS NO REPLAY. A subscriber attaching mid-scenario
// is not owed the ticks it missed: what it is owed is the room as it stands, which it
// gets by reading — and every push-driven read in the console reads once at start for
// that reason.

import { activityFrameDueAt } from "./fixture-activity.js";
import type { Unsubscribe } from "../../core/index.js";
import type { AwarenessSignalStream } from "../daemon/index.js";
import type { ScenarioActivityFrame, ScenarioEngine } from "../scenario-runtime/index.js";

/**
 * One open Awareness subscription: the two triggers, and the frame it last signalled.
 *
 * A class with private fields rather than a closure over a `let`, on the rule the
 * fixture's other stateful stand-ins keep: the watermark is state a subscription owns,
 * and it owns a teardown for both of the triggers that write it.
 */
class ScenarioPresenceSignal {
  readonly #engine: ScenarioEngine;
  readonly #stream: AwarenessSignalStream;
  readonly #deliver: () => void;
  /**
   * The tick of the activity frame this subscription has already signalled for.
   *
   * Seeded from the clock as it stands at ATTACH rather than left empty, because the
   * subscriber reads immediately after subscribing: a watermark starting below the
   * current frame would fire on the next advance for a frame the reader already has,
   * which is the same publication read twice — the one thing the feed's own fold
   * treats as a refresh.
   */
  #signalledFrameAtMs: number | undefined;

  public constructor(engine: ScenarioEngine, stream: AwarenessSignalStream, deliver: () => void) {
    this.#engine = engine;
    this.#stream = stream;
    this.#deliver = deliver;
    this.#signalledFrameAtMs = this.#frameDueAt(engine.progress.elapsedMs)?.atMs;
  }

  /** Open both triggers. The returned disposer closes both, once. */
  public attach(): Unsubscribe {
    const unsubscribeFromBeats = this.#engine.subscribe((events) => {
      if (events.some((event) => this.#stream.carriedKinds.includes(event.kind))) {
        this.#deliver();
      }
    });
    const unsubscribeFromAdvances = this.#engine.subscribeToAdvances((elapsedMs) => {
      this.#signalIfFrameMoved(elapsedMs);
    });
    return () => {
      unsubscribeFromBeats();
      unsubscribeFromAdvances();
    };
  }

  #signalIfFrameMoved(elapsedMs: number): void {
    const dueAtMs = this.#frameDueAt(elapsedMs)?.atMs;
    if (dueAtMs === this.#signalledFrameAtMs) {
      return;
    }
    this.#signalledFrameAtMs = dueAtMs;
    this.#deliver();
  }

  #frameDueAt(elapsedMs: number): ScenarioActivityFrame | undefined {
    return activityFrameDueAt(this.#engine.scenario.activity ?? [], elapsedMs);
  }
}

/**
 * Subscribe one caller to this session's Awareness room.
 *
 * The delivery carries `undefined` and that is the registered shape rather than a
 * shortcut: both console subscribers take the push as `void` and answer it with a
 * fresh read, so a fixture that composed an envelope here would hand them a value the
 * live bridge does not send and that nothing is allowed to open.
 */
export function subscribeToScenarioPresence(
  engine: ScenarioEngine,
  stream: AwarenessSignalStream,
  deliver: (signal: undefined) => void,
): Unsubscribe {
  return new ScenarioPresenceSignal(engine, stream, () => {
    deliver(undefined);
  }).attach();
}
