// The reach forms, driven against sources whose verdict is known.
//
// THE GATE IS NEXT DOOR AND THIS IS THE MODEL'S OWN BENCH, on the `barrel-census.ts`
// pattern the reach module's header names: `daemon-reply-chokepoint.test.ts` makes the
// claim over the real console, and a clean result there is worth nothing until the
// needles are proved to bite. Every case below writes a source the console does not
// contain — the offending shapes included, which is why they cannot be written in the
// gate itself, and why the gate keeps only the two assertions that read the real tree.
//
// ITS SUBJECT IS WHAT A MODULE DID PAST THE DOOR, and never which binding the door is.
// `daemon-call-census.test.ts` drives the consumption needle and
// `daemon-call-sites.test.ts` drives the callee resolution through the site scan; a
// reach form is read off the bridge's own namespace and resolves no binding at all, which
// is why the two benches ask two things of two modules.

import { describe, expect, it } from "vitest";

import { daemonCallReaches } from "./daemon-reach-forms.js";

describe("what a module shows about reaching past the call door", () => {
  it("negative control: the needles separate a reach from a mention", () => {
    // The line the census module's header draws, asserted against the predicate rather
    // than against whichever module happens to name the door in prose today.
    expect(daemonCallReaches("const reply = await bridge.sidekicks.daemon.call(method, params);")) //
      .toContain("called or aliased");
    expect(daemonCallReaches("const call = bridge.sidekicks.daemon.call as Widened;")) //
      .toContain("called or aliased");
    expect(daemonCallReaches("const { call } = bridge.sidekicks.daemon;")) //
      .toContain("namespace taken");
    expect(daemonCallReaches("// a bridge that dropped `daemon.call` would be wrong")) //
      .toStrictEqual([]);
    expect(daemonCallReaches("this.#bridge.sidekicks.daemon.subscribe(name, onFrame);")) //
      .toStrictEqual([]);
  });

  it("sees the same door reached by a computed key or handed on as a value", () => {
    // Planted, and each one is the SMALLEST violation that passed the two dotted
    // needles: one bracket, and a scan over text reads the tree as compliant. A
    // module that smuggles a reply out this way holds an `unknown` it can cast,
    // which needs no validator, so the lint ban beside this scan does not cover it.
    //
    // The first is now reported by TWO forms rather than one, and that is the reading
    // improving rather than a rule widening: `sidekicks["daemon"].call(…)` really is
    // both the namespace taken by a key and the door called, and the text needle
    // reported only the half whose spelling it was written for.
    expect(
      daemonCallReaches(`const reply = await bridge.sidekicks["daemon"].call(name, params);`),
    ).toStrictEqual(["called or aliased", "namespace taken by computed key"]);
    expect(daemonCallReaches(`const door = bridge.sidekicks["daemon"];`)) //
      .toStrictEqual(["namespace taken by computed key"]);
    // And with BOTH steps bracketed, which is the shape that used to fall between the
    // two readings: the dotted needle did not see the first step and the computed one
    // was asking about the second, so a module could take the namespace and be reported
    // by neither. One member predicate for both spellings is what closes it.
    expect(daemonCallReaches(`const door = bridge["sidekicks"]["daemon"];`)) //
      .toStrictEqual(["namespace taken by computed key"]);
    expect(daemonCallReaches(`const send = bridge.sidekicks.daemon["call"];`)) //
      .toStrictEqual(["called by computed key"]);
    expect(daemonCallReaches("const bound = bridge.sidekicks.daemon.call.bind(bridge);")) //
      .toStrictEqual(["taken as a value"]);
  });

  it("sees the same door reached under a transparent wrapper", () => {
    // THE REACH A DOTTED READING STOPPED ONE NODE ABOVE. Each line below is the reach the
    // needle already names, written with a wrapper the emitter deletes — and the first two
    // were reported as NO reach at all, which is this gate green over a module holding the
    // wire. The third was reported as the namespace merely taken, because the parenthesis
    // hid the step that reads `call` off it: a wrong form name for a real reach, and the
    // same defect in the direction that still fires.
    expect(daemonCallReaches("const reply = (bridge.sidekicks.daemon.call)(method);")) //
      .toStrictEqual(["called or aliased"]);
    expect(daemonCallReaches("const reply = bridge.sidekicks.daemon.call!(method);")) //
      .toStrictEqual(["called or aliased"]);
    expect(daemonCallReaches("const reply = (bridge.sidekicks.daemon).call(method);")) //
      .toStrictEqual(["called or aliased"]);
    expect(daemonCallReaches('const door = (bridge.sidekicks as BridgeApi)["daemon"];')) //
      .toStrictEqual(["namespace taken by computed key"]);
    expect(daemonCallReaches("const bound = (bridge.sidekicks.daemon.call).bind(bridge);")) //
      .toStrictEqual(["taken as a value"]);
    // And the namespace form keeps its own reading under a wrapper: nothing steps through
    // this one, so it is taken rather than called.
    expect(daemonCallReaches("const { call } = (bridge.sidekicks.daemon satisfies DaemonApi);")) //
      .toStrictEqual(["namespace taken"]);
  });

  it("negative control: a computed key in prose or on another noun is not a reach", () => {
    // The other direction of the same claim. A needle that fired on either of these
    // would be turned off within a week, which is how the scan stops existing.
    expect(daemonCallReaches("// the daemon [the local runtime] answers `unknown`")) //
      .toStrictEqual([]);
    expect(daemonCallReaches("const first = daemonEvents[0];")).toStrictEqual([]);
    expect(daemonCallReaches("const kinds = this.#sidekicksByName;")).toStrictEqual([]);
    // The sentence that was reworded rather than reported: a seam's header naming the
    // namespace it deliberately does NOT reach. The text needle fired on it, and the
    // disposition a red gate on prose invites is editing the prose.
    expect(
      daemonCallReaches(
        "// the shipped component reads `window.sidekicks.daemon` directly, which the\n// fixture cannot serve",
      ),
    ).toStrictEqual([]);
    // A string naming the door is data rather than a reach, for the same reason.
    expect(daemonCallReaches('const method = "sidekicks.daemon.call";')).toStrictEqual([]);
  });
});
