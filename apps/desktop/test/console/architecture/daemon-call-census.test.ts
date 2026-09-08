// The door-consumption needle, driven against sources whose verdict is known.
//
// THE GATE IS NEXT DOOR AND THIS IS THE MODEL'S OWN BENCH, on the `barrel-census.ts`
// pattern the census module's header names: `daemon-reply-chokepoint.test.ts` makes the
// claim over the real console, and a clean result there is worth nothing until the
// needles are proved to bite. Every case below writes a source the console does not
// contain — the offending shapes included, which is why they cannot be written in the
// gate itself, and why the gate keeps only the two assertions that read the real tree.
//
// ONE SUBJECT, BECAUSE THE MODULE HAS ONE. `importsCallDoor` asks whether a module
// consumes the door itself; how a module shows it reached PAST the door to `daemon.call`
// is `daemon-reach-forms.ts`' question and `daemon-reach-forms.test.ts`' bench. The two
// were one file until the door's identity grew its module half, and the benches split
// with their subjects rather than one bench keeping a door it no longer drives.
//
// AND A PLANTED CLAUSE NAMES THE DOOR'S REAL MODULE, which is part of the reading and
// not scaffolding around it. An export is a (module, name) pair, so a case writing
// `"./elsewhere.js"` is a case about a DIFFERENT `callDaemon` — every accepted-set clause
// below therefore resolves to `console/bridge/index.ts` from the probe's own path, and
// the case that plants another module is the negative control that says so.
//
// WHAT A DOOR CALL SAYS IS THE THIRD BENCH'S SUBJECT, not restated here.
// `daemon-call-sites.test.ts` drives `namesCallDoor` through the site scan that consumes
// it; this file drives it through the consumer census, which is the other consumer of
// the same predicate. Neither bench re-implements the reading, and between them both of
// its binding forms are exercised on both sides.

import { describe, expect, it } from "vitest";

import {
  NAMESPACE_DOOR_CALLEES,
  WRAPPED_NAMESPACE_DOOR_CALLEES,
} from "./daemon-call-planting.test-support.js";
import { importsCallDoor } from "./daemon-call-census.js";

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

  it("takes the door imported from the module that declares it, not only the barrel", () => {
    // THE DOOR HAS TWO HOMES AND BOTH ARE ADMITTED. `bridge/daemon/daemon-reply.ts`
    // declares `callDaemon` and `bridge/index.ts` re-exports it, and which one a module
    // writes is a question about where it sits: the bridge family's own modules import
    // the declaring module directly — a family door reached from inside its own family is
    // the barrel chain the package forbids — while every consumer outside it goes through
    // the door. A reading admitting only the barrel would report the family's own
    // consumers as reaching nothing.
    expect(
      importsCallDoor(
        'import { callDaemon } from "./daemon-reply.js";',
        "console/bridge/daemon/queue-probe.ts",
      ),
    ).toBe(true);
    expect(
      importsCallDoor(
        'import { callDaemon } from "../daemon/daemon-reply.js";',
        "console/bridge/quotas/provider-account-quota.ts",
      ),
    ).toBe(true);
  });

  it("negative control: the door's own name imported from another module is not the door", () => {
    // THE HOLE THE NAME-ONLY IDENTITY LEFT. A clause was the door's the moment it
    // carried the spelling, whatever module it named — so a module publishing its own
    // `callDaemon` from anywhere in the tree was counted a consumer of the bridge's, and
    // the pinned number was a count of a spelling rather than of the door.
    expect(importsCallDoor('import { callDaemon } from "./not-the-door.js";')).toBe(false);
    // The aliased spelling of the same defect: the local name says nothing, and the
    // module the clause names is the whole of the answer.
    expect(importsCallDoor('import { callDaemon as send } from "./not-the-door.js";')).toBe(false);
    // And the two shapes the resolver itself refuses, which is where the honest limit
    // now sits: a package specifier this walk does not reach, and one climbing out of the
    // scanned roots. Both answer nothing, and nothing is not the door.
    expect(importsCallDoor('import { callDaemon } from "@ai-sidekicks/contracts";')).toBe(false);
    expect(
      importsCallDoor('import { callDaemon } from "../../../elsewhere/index.js";', "probe.ts"),
    ).toBe(false);
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

  it("negative control: a transparent wrapper does not hide the consumption", () => {
    // THE NAMESPACE HOLE ONE NODE DEEPER. The door read off a namespace is a member read,
    // and the object it steps off is resolved exactly as a bare callee is — so a cast,
    // a `!` or a parenthesis around that object left this census answering `false` while
    // the site scan beside it skipped the same callee. Two numbers that have to move
    // together, moving neither, which is the shape this whole census exists to refuse.
    for (const door of WRAPPED_NAMESPACE_DOOR_CALLEES) {
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
    // And the shadow still wins under the same wrapper, so what moved is the reading of
    // the expression rather than the rule about which binding counts.
    expect(
      importsCallDoor(
        [
          'import * as daemonDoor from "../bridge/index.js";',
          "export function withStub(bridge, request) {",
          "  const daemonDoor = { callDaemon: stubbedCall };",
          "  return (daemonDoor as typeof daemonDoor).callDaemon(bridge, request);",
          "}",
        ].join("\n"),
      ),
    ).toBe(false);
  });
});
