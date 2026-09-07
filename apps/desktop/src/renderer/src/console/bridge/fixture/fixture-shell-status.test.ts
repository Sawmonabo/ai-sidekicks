// A daemon control moves the fixture's shell, and the script gets it back.
//
// THE FINDING. `current()` answered the override before it ever consulted the frozen
// clock, so the first control a person pressed silenced the rest of the scenario: a
// restart published `starting`, the shell scenario's own `connected` frame at tick 800
// could never be emitted, and the frame stayed reconnecting for the whole run however
// far the clock was advanced. The stamp is the repair — an override belongs to the tick
// it was published at, and a frame due after that tick is the scenario speaking later
// still.
//
// WHY THE SHELL SCENARIO AND NOT A HAND-WRITTEN SCRIPT. The three frames this file
// drives are the ones a person actually meets in the switcher, and the defect was
// reachable through them and nowhere else — a probe scenario written here would have
// proved a rule against a script the console does not ship. The ticks are read from
// `SHELL_SCENARIO` rather than restated, so a scenario whose frames move takes these
// cases with it instead of leaving them green against numbers nobody kept.
//
// WHAT IS NOT HERE. The unscripted refusal and the three controls' wire shapes are
// `fixture-growth-port`'s; this file owns the channel's ordering rule and nothing else.

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import type { ShellReport } from "../../store/index.js";
import type { GrowthStream } from "../growth-port/growth-outcome.js";
import { ScenarioEngine } from "../scenario-runtime/index.js";
import { SHELL_SCENARIO } from "../scenarios/shell.js";
import { FixtureShellChannel, startingReport, stoppedReport } from "./fixture-shell-status.js";

/**
 * The scenario's own frame ticks, read rather than restated.
 *
 * Named by position because that is what each one is FOR: the shell opens degraded at
 * the first, and the last is the quiet connected state a restart has to be able to
 * reach.
 */
const SCRIPTED_FRAMES = SHELL_SCENARIO.shellStatus ?? [];
const FIRST_FRAME_AT_MS = SCRIPTED_FRAMES[0]?.atMs ?? 0;
const LAST_FRAME_AT_MS = SCRIPTED_FRAMES.at(-1)?.atMs ?? 0;

/** One tick past the last scripted frame, so an advance lands with nothing else due. */
const PAST_LAST_FRAME_MS = LAST_FRAME_AT_MS + 100;

/** The channel under test, over the scenario a person picks from the switcher. */
function shellChannelOverScenario(): { engine: ScenarioEngine; channel: FixtureShellChannel } {
  const engine = new ScenarioEngine({ scenario: SHELL_SCENARIO });
  return { engine, channel: new FixtureShellChannel(engine) };
}

/** The feed the scenario scripts. `undefined` here would be a scenario that lost its frames. */
function openScriptedFeed(channel: FixtureShellChannel): GrowthStream<ShellReport> {
  const stream = channel.open();
  if (stream === undefined) {
    throw new Error("the shell scenario declares no shellStatus frames");
  }
  return stream;
}

/** What the shell is saying, where a case has already established that it is saying something. */
function currentReport(channel: FixtureShellChannel): ShellReport {
  const report = channel.current();
  if (report === undefined) {
    throw new Error("the channel reported nothing where the scenario scripts a frame");
  }
  return report;
}

/**
 * Drain a feed into an array for as long as the caller keeps it open.
 *
 * The stream buffers a single latest-wins slot and parks on a promise between wakes,
 * so a case cannot read it synchronously: the loop runs beside the case and each
 * assertion is taken after a macrotask boundary, which is the wait every other fixture
 * suite uses rather than a count tuned to this generator's depth.
 */
function drainShellReports(stream: GrowthStream<ShellReport>): {
  readonly received: readonly ShellReport[];
  readonly stop: () => Promise<void>;
} {
  const received: ShellReport[] = [];
  const drained = (async () => {
    for await (const report of stream.events) {
      received.push(report);
    }
  })();
  return {
    received,
    stop: async () => {
      stream.close();
      await drained;
    },
  };
}

/** Every connection kind the feed yielded, which is the whole of what these cases claim. */
function connectionKinds(reports: readonly ShellReport[]): readonly string[] {
  return reports.map((report) => report.connection.kind);
}

describe("the fixture shell channel — a control overrides, the script takes it back", () => {
  it("emits the scripted connected frame after a restart parked the shell at starting", async () => {
    // The finding, end to end: the restart's `starting` is what a person sees, and the
    // supervisor's own later report is what says the runtime came back. Before the
    // stamp the second half never arrived.
    const { engine, channel } = shellChannelOverScenario();
    const feed = drainShellReports(openScriptedFeed(channel));
    await crossMacrotaskBoundary();
    expect(connectionKinds(feed.received)).toStrictEqual(["reconnecting"]);

    channel.publish(startingReport(currentReport(channel)));
    await crossMacrotaskBoundary();
    expect(connectionKinds(feed.received)).toStrictEqual(["reconnecting", "starting"]);

    engine.advance(PAST_LAST_FRAME_MS);
    await crossMacrotaskBoundary();
    expect(connectionKinds(feed.received)).toStrictEqual(["reconnecting", "starting", "connected"]);
    expect(channel.current()?.connection.kind).toBe("connected");

    await feed.stop();
  });

  it("keeps an override the script has nothing later to say about", async () => {
    // The control that would break if superseding were read the wrong way round. A stop
    // published after the last scripted frame is the last word there is, and a channel
    // that let the script win would be a fixture teaching every surface above it that a
    // control can be pressed and change nothing.
    const { engine, channel } = shellChannelOverScenario();
    engine.advance(PAST_LAST_FRAME_MS);
    const feed = drainShellReports(openScriptedFeed(channel));
    await crossMacrotaskBoundary();
    expect(connectionKinds(feed.received)).toStrictEqual(["connected"]);

    channel.publish(stoppedReport(currentReport(channel)));
    engine.advance(PAST_LAST_FRAME_MS);
    await crossMacrotaskBoundary();

    expect(connectionKinds(feed.received)).toStrictEqual(["connected", "stopped"]);
    expect(channel.current()?.connection.kind).toBe("stopped");

    await feed.stop();
  });

  it("holds an override published on the very tick a frame fell due", () => {
    // `>` and not `>=`, pinned. The scenario's first frame is due at tick zero and the
    // control is pressed at tick zero, which is AFTER that frame became current — a
    // channel comparing with `>=` would answer the frame the control had just replaced.
    const { channel } = shellChannelOverScenario();
    expect(FIRST_FRAME_AT_MS).toBe(0);

    channel.publish(stoppedReport(currentReport(channel)));

    expect(channel.current()?.connection.kind).toBe("stopped");
  });
});
