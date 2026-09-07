// The shell plane composes its six answers out of ONE channel — and one that is not.
//
// WHAT THESE CASES ARE FOR. The plane's five channel-backed operations are five
// separate members of one object literal, and nothing in a type would notice a handler
// that minted a channel of its own: every arm would still typecheck, the feed would
// still open, and a stop would still resolve `served` — while moving a shell no surface
// is watching. That is invisible in a diff and invisible on screen until a person
// presses a control, which is why the sharing is pinned here rather than left to the
// composition reading correctly.
//
// AND THE ONE ANSWER THAT IS NOT THE CHANNEL'S is pinned from the other side: the
// notification-permission read answers about the MACHINE, so it serves from a script
// under a scenario that declares no shell condition at all — which is exactly the
// scenario the five channel operations refuse under. The two scenarios below are the
// shipped ones that hold those two states, so a scenario whose script moves takes these
// cases with it rather than leaving them green against a fixture written here.
//
// WHAT IS NOT HERE. The channel's own ordering rule — how a scripted frame and a
// control override are ranked against the frozen clock — is `fixture-shell-status`'s,
// and the served-set sweep over every operation is `fixture-growth-port`'s.

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import type { ShellReport } from "../../store/index.js";
import type { GrowthStream } from "../growth-port/growth-outcome.js";
import { ScenarioEngine } from "../scenario-runtime/index.js";
import { BRING_YOUR_HISTORY_SCENARIO } from "../scenarios/bring-your-history.js";
import { SHELL_SCENARIO } from "../scenarios/shell.js";
import { fixtureShellAnswers } from "./fixture-shell-answers.js";

/** The plane under test, over one shipped scenario. */
function shellAnswersOver(
  scenario: typeof SHELL_SCENARIO,
): ReturnType<typeof fixtureShellAnswers> & { readonly engine: ScenarioEngine } {
  const engine = new ScenarioEngine({ scenario });
  return { ...fixtureShellAnswers(engine), engine };
}

/**
 * The feed a scenario scripts, or a failure naming what is missing.
 *
 * The refusal arm is a scenario that lost its frames rather than anything these cases
 * claim, so it throws here instead of being asserted at every call site.
 */
async function openScriptedFeed(
  plane: ReturnType<typeof fixtureShellAnswers>,
): Promise<GrowthStream<ShellReport>> {
  const outcome = await plane.shellStatusSubscribe({});
  if (outcome.status !== "served") {
    throw new Error("the shell scenario declares no shellStatus frames");
  }
  return outcome.value;
}

/** Drain a feed for as long as the caller keeps it open, on the channel suite's rule. */
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

describe("the fixture shell answers — one channel behind the feed, the read and the controls", () => {
  it("lets a control move what the feed and the status read both say", async () => {
    // The whole claim of the composition, and the case a per-handler channel fails: the
    // stop is published through one handler and observed through two others. A plane
    // that minted a channel per arm answers `served` here and yields nothing on the
    // feed, leaving a person pressing a control that changes nothing on screen.
    const plane = shellAnswersOver(SHELL_SCENARIO);
    const feed = drainShellReports(await openScriptedFeed(plane));
    await crossMacrotaskBoundary();
    expect(feed.received.map((report) => report.connection.kind)).toStrictEqual(["reconnecting"]);

    const stopped = await plane.daemonStop({});
    await crossMacrotaskBoundary();

    expect(stopped.status).toBe("served");
    expect(feed.received.map((report) => report.connection.kind)).toStrictEqual([
      "reconnecting",
      "stopped",
    ]);
    const status = await plane.daemonStatusRead({});
    expect(status.status === "served" ? status.value.state : undefined).toBe("stopped");

    await feed.stop();
  });

  it("refuses all five channel answers, by name, for a scenario that declares no shell", async () => {
    // The negative control the case above needs: without it the sharing would be
    // asserted over a plane that could equally be answering from a shell it invented,
    // and the refusal that keeps this fixture honest would go unchecked. `bring-your-
    // history` scripts no `shellStatus`, so the channel has nothing to report and every
    // arm that reads it names the SCENARIO's gap rather than an unbuilt wire.
    const plane = shellAnswersOver(BRING_YOUR_HISTORY_SCENARIO);

    for (const outcome of await Promise.all([
      plane.shellStatusSubscribe({}),
      plane.daemonStatusRead({}),
      plane.daemonStop({}),
      plane.daemonRestart({}),
      plane.daemonStart({}),
    ])) {
      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.code).toBe("reply-unscripted");
      }
    }
  });

  it("answers the notification permission from the script of that same shell-less scenario", async () => {
    // The other half of the split, and the reason the permission read is not folded into
    // the channel: it is a fact about the MACHINE and not about the runtime the controls
    // move, so it serves under exactly the scenario every channel answer above refuses
    // under. Folded in, a daemon stop would change what a person is told about
    // notifications.
    const plane = shellAnswersOver(BRING_YOUR_HISTORY_SCENARIO);

    const outcome = await plane.shellNotificationPermissionRead({});

    expect(outcome.status).toBe("served");
    expect(outcome.status === "served" ? outcome.value.state : undefined).toBe("denied");
  });
});
