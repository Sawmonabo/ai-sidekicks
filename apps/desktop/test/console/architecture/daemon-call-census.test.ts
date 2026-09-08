// The reach and consumption needles, driven against sources whose verdict is known.
//
// THE GATE IS NEXT DOOR AND THIS IS THE MODEL'S OWN BENCH, on the `barrel-census.ts`
// pattern the census module's header names: `daemon-reply-chokepoint.test.ts` makes the
// claim over the real console, and a clean result there is worth nothing until the
// needles are proved to bite. Every case below writes a source the console does not
// contain — the offending shapes included, which is why they cannot be written in the
// gate itself, and why the gate keeps only the two assertions that read the real tree.
//
// TWO SUBJECTS, BECAUSE THE MODULE HAS TWO. `daemonCallReaches` asks how a module shows
// it reached PAST the door to `daemon.call`, and `importsCallDoor` asks whether it
// consumes the door itself. They share a file for the reason the census module states —
// one boundary, and one place the door's own name is declared — and they are separate
// describes here because a case is about one of them.
//
// WHAT A DOOR CALL SAYS IS THE THIRD BENCH'S SUBJECT, not restated here.
// `daemon-call-sites.test.ts` drives `namesCallDoor` through the site scan that consumes
// it; this file drives it through the consumer census, which is the other consumer of
// the same predicate. Neither bench re-implements the reading, and between them both of
// its binding forms are exercised on both sides.

import { describe, expect, it } from "vitest";

import { NAMESPACE_DOOR_CALLEES } from "./daemon-call-planting.test-support.js";
import { daemonCallReaches, importsCallDoor } from "./daemon-call-census.js";

describe("what a module shows about consuming the call door", () => {
  it("negative control: the consumer needle sees an ordinary import of the door", () => {
    // Without this, the pinned count in the gate would be reporting a broken needle
    // rather than the tree, and a needle that matched nothing would read the console as
    // having no consumers at all — green, and saying nothing.
    expect(importsCallDoor(`import { callDaemon } from "../bridge/index.js";`)).toBe(true);
    expect(
      importsCallDoor(
        ["import {", "  callDaemon,", "  type DaemonReply,", '} from "../bridge/index.js";'].join(
          "\n",
        ),
      ),
    ).toBe(true);
    // An alias is still a consumption, and the local name it takes is not the door's.
    expect(importsCallDoor('import { callDaemon as send } from "../bridge/index.js";')).toBe(true);
    // And not on the door merely named in prose, which several modules do carry.
    expect(importsCallDoor("// a surface reaches the wire through `callDaemon`")).toBe(false);
    // The false-positive direction the text needle was narrowed twice to survive: this
    // sentence contains the word `import`, and a scan over text spanned the newlines
    // between the two words because nothing ended the statement in between. An import
    // clause is a node; a comment carrying both words in any order is not one.
    expect(
      importsCallDoor(
        [
          "// a surface would import",
          "// `callDaemon` from the bridge door rather than reach the wire itself",
        ].join("\n"),
      ),
    ).toBe(false);
    expect(importsCallDoor('const note = "import { callDaemon } from the door";')).toBe(false);
    // And a longer name that merely starts with the door's is a different symbol.
    expect(importsCallDoor('import { callDaemonRegistry } from "./registry.js";')).toBe(false);
  });

  it("negative control: the consumer needle sees the door read off a namespace import", () => {
    // THE CONSUMER THE CLAUSE READING COULD NOT SEE, and the reason the gate's pin was
    // not the floor it looks like. A namespace import binds no specifier to enumerate,
    // so this needle skipped the whole shape — and a module reaching the door that way
    // contributed no calls to the site scan either, which is a surface holding the wire
    // while every count that protects it stays satisfied.
    //
    // COUNTED IN BOTH SPELLINGS OF THE READ, from the corpus's own declared set — the
    // same set the site scan drives. A predicate admitting only the dotted form left
    // this census answering `false` for the bracketed one, so the module was outside the
    // pinned consumer count while the scan beside it was skipping the same callee: two
    // numbers that have to move together, moving neither.
    for (const door of NAMESPACE_DOOR_CALLEES) {
      expect(
        importsCallDoor(
          [
            'import * as daemonDoor from "../bridge/index.js";',
            `export const reply = ${door}(bridge, "session.join", request);`,
          ].join("\n"),
        ),
        door,
      ).toBe(true);
    }
    // And not through a key this parse cannot resolve, which names no member at all.
    expect(
      importsCallDoor(
        [
          'import * as daemonDoor from "../bridge/index.js";',
          "export const reply = daemonDoor[member](bridge, request);",
        ].join("\n"),
      ),
    ).toBe(false);
    // The local name is not what decides it, and neither is invoking the door: a named
    // import that is never called counts, so a namespace read that is never called has
    // to count with it or one number moves differently for two spellings of one act.
    expect(
      importsCallDoor(
        [
          'import * as wire from "../bridge/index.js";',
          "export const send = wire.callDaemon;",
        ].join("\n"),
      ),
    ).toBe(true);
    // And the half a clause reading would have got wrong in the other direction: a
    // module that imports the family for anything else is not a consumer of the door.
    expect(
      importsCallDoor(
        [
          'import * as bridge from "../bridge/index.js";',
          "export const refusal = bridge.formatRefusal(code);",
        ].join("\n"),
      ),
    ).toBe(false);
    // Nor is the door's own name read off something that is not a namespace at all.
    expect(importsCallDoor("export const reply = bridge.callDaemon(method, request);")).toBe(false);
    // Nor off a namespace a nearer binding shadows, which is the same reading the site
    // scan makes of the same scopes: the local wins, and a local is not the door.
    expect(
      importsCallDoor(
        [
          'import * as daemonDoor from "../bridge/index.js";',
          "export function withStub(bridge, request) {",
          "  const daemonDoor = { callDaemon: stubbedCall };",
          "  return daemonDoor.callDaemon(bridge, request);",
          "}",
        ].join("\n"),
      ),
    ).toBe(false);
  });
});

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
