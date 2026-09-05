// The daemon-reply chokepoint, asserted from both sides.
//
// THE CLAIM. Every daemon reply the console reads is parsed against the shape the
// corpus registers for that method, because there is exactly one module that
// reaches the bridge's call door — `console/bridge/daemon-reply.ts` — and exactly
// one family that may hold a validator to parse with. Neither half is a property a
// compiler can see: the bridge's `call` answers `unknown`, so a surface that reaches
// it directly type-checks perfectly and reports success on a value nobody read.
//
// TWO GATES, TWO MECHANISMS, ONE BOUNDARY. They are here in one file because they
// fail together and for the same reason, and splitting them would mean writing this
// paragraph twice:
//
//   • The CALL side is source text. A surface holds a `ConsoleBridge` from
//     `BridgeProvider`, so nothing structural stops it from writing
//     `bridge.sidekicks.daemon.call(…)` and awaiting an `unknown`. This file scans
//     for that reach.
//   • The PARSE side is `no-restricted-imports` in `apps/desktop/eslint.config.mjs`:
//     `zod` is banned everywhere under `console/` and `shell/` except
//     `console/bridge/**`. A surface that cannot import a validator cannot write a
//     second, different reading of a seam the registry already binds.
//
// AND ONE CENSUS, BECAUSE THE CALL SIDE IS VACUOUS UNTIL A SURFACE CALLS. Both
// claims are true of an empty set on this branch: the door has no consumers yet, so
// "no module outside the bridge family reaches it" reports compliance without
// distinguishing that from "every caller goes through it", which is what this file's
// title claims. The consumer count is therefore PINNED rather than left implicit —
// see `CALL_DOOR_CONSUMER_COUNT`.
//
// The lint half is driven through the REAL ESLint engine over the REAL config, never
// re-implemented — a test carrying its own copy of the pattern list would stay green
// with the config deleted, which is the failure it exists to prevent. The engine, the
// probe paths, and the per-case budget come from `test/console/eslint-harness.ts`, which
// three gates now share; the budget's derivation is recorded there.
//
// The reach needles live in `daemon-call-census.ts` beside this file, on the
// `barrel-census.ts` pattern: this file is the rule applied to the real tree, that one
// is the rule.
//
// WHAT IS DELIBERATELY NOT SCANNED.
//   • `daemon.subscribe`. A subscription is a different seam with a different
//     failure mode — a stream is projected per frame, not parsed once — and
//     `frame/session-event-binder.ts` owns it. Folding it in here would make this
//     file the gate for two chokepoints and give neither an honest name.
//   • The three shipped Tier-1 renderer families (`session-bootstrap/`,
//     `session-members/`, `runtime-node-attach/`). They predate the console, are
//     owned by other plans, reach their own bridge, and import nothing from
//     `console/bridge/` — so a call there is that plan's to place, and a gate here
//     would fire on a change this console has no standing to refuse.
//   • The `shell/` subtree is scanned WHEN IT EXISTS. It does not on this branch;
//     the package's own structure rules place it beside the console as a
//     `console-unit` resident, so it is named here rather than added later and
//     forgotten.

import { describe, expect, it, vi } from "vitest";

import {
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import {
  createDesktopLinter,
  ESLINT_CASE_BUDGET_MS,
  rendererProbePath,
  ruleMessagesAt,
} from "../eslint-harness.js";
import { CALL_DOOR_IMPORT, daemonCallReaches } from "./daemon-call-census.js";

/**
 * The walk, done once, and shared with every other source-text gate.
 *
 * `{ tests: true }` is this gate's one divergence from the default and the reason
 * the walk takes the flag at all: a test outside the bridge family stands in for a
 * surface, and a surface goes through the door. It rides as a parameter rather than
 * as this file's own `readdirSync` — which is what it was, with an exclusion list
 * that differed from the shared one and from the subject gate's, so the three walks
 * disagreed about `.test-support.*` with nothing reporting it.
 *
 * The roots are the shared walk's default, `console/` and `shell/`; the second does
 * not exist on this branch, contributes no modules rather than throwing, and the
 * vacuity guard below is what keeps that from turning into a silent pass.
 */
const GOVERNED_MODULES: readonly ConsoleSourceModule[] = consoleSourceModules({ tests: true });

/**
 * The one production module allowed to reach the bridge's call door.
 *
 * A path rather than a naming convention, so moving the chokepoint is an edit a
 * reviewer sees in this file.
 */
const CHOKEPOINT_MODULE = "console/bridge/daemon-reply.ts";

/**
 * The bridge family, which its own tests and support modules may drive directly.
 *
 * Scoped to `bridge/` rather than to test files generally. A bridge test exercises
 * the door itself — `scripted-reply.test.ts` asserts what the fixture answers a raw
 * call with, and `fixture-bridge.test-support.ts` exists to make that raw call — so
 * routing them through `callDaemon` would mean testing the chokepoint through the
 * chokepoint. A test in any OTHER family has no such excuse: it is standing in for
 * a surface, and a surface goes through the door.
 */
const BRIDGE_FAMILY_PREFIX = "console/bridge/";

/** Every governed source module, as a renderer-root-relative path. */
function governedSourceModules(): readonly string[] {
  return GOVERNED_MODULES.map((module) => module.displayPath);
}

function readGovernedSource(module: string): string {
  return readConsoleSourceModule(moduleNamed(GOVERNED_MODULES, module));
}

function isBridgeFamilyModule(module: string): boolean {
  return module.startsWith(BRIDGE_FAMILY_PREFIX);
}

/**
 * How many modules outside the bridge family import the call door on this branch.
 *
 * ONE — `console/repos/repo-reads.ts`, the repos family's five `repo.*` reads, which
 * is the first surface-side consumer the console has. The claim above stopped being
 * vacuous when that module landed: it used to reach `daemon.call` itself and hold its
 * own parser and its own two refusal codes beside it, and it now names five registry
 * keys and holds none of the three.
 *
 * PINNED rather than left as a floor, because a floor cannot tell "every caller goes
 * through the door" from "nobody calls the daemon at all". It fails the moment the
 * number moves in either direction, so the family lane that binds the next surface —
 * the composer's send router and the runs pane's run controls are the two nearest,
 * both T-023p-1C-3 — moves this constant in its own PR, and a reader learns from that
 * diff that the set has grown. It cannot be raised by accident either.
 */
const CALL_DOOR_CONSUMER_COUNT = 1;

describe("daemon-reply chokepoint — one module reaches the call door", () => {
  const modules = governedSourceModules();

  it("finds a tree to scan at all", () => {
    // Without this, a wrong root would scan nothing and every assertion below
    // would pass over the empty set.
    expect(modules.length).toBeGreaterThan(50);
    expect(modules).toContain(CHOKEPOINT_MODULE);
  });

  it("no module outside the bridge family reaches the daemon call door", () => {
    const offenders = modules
      .filter((module) => !isBridgeFamilyModule(module))
      .map((module) => ({ module, reaches: daemonCallReaches(readGovernedSource(module)) }))
      .filter((entry) => entry.reaches.length > 0)
      .map((entry) => `${entry.module}: ${entry.reaches.join(", ")}`);

    expect(offenders).toStrictEqual([]);
  });

  it("no bridge-family PRODUCTION module but the chokepoint reaches it either", () => {
    // The exemption above is scoped to the family because its tests drive the raw
    // door on purpose. Production code in that family gets no such licence: the
    // registry, the fixture, the projector and the provider all sit beside the
    // chokepoint and would each be a second door.
    const offenders = modules
      .filter(
        (module) =>
          isBridgeFamilyModule(module) &&
          module !== CHOKEPOINT_MODULE &&
          !module.includes(".test.") &&
          !module.includes(".test-support."),
      )
      .map((module) => ({ module, reaches: daemonCallReaches(readGovernedSource(module)) }))
      .filter((entry) => entry.reaches.length > 0)
      .map((entry) => `${entry.module}: ${entry.reaches.join(", ")}`);

    expect(offenders).toStrictEqual([]);
  });

  it("counts what consumes the call door, against a pinned number", () => {
    const consumers = modules
      .filter((module) => !isBridgeFamilyModule(module))
      .filter((module) => CALL_DOOR_IMPORT.test(readGovernedSource(module)));

    expect(
      consumers.length,
      `modules importing the call door: ${consumers.join(", ") || "none"}`,
    ).toBe(CALL_DOOR_CONSUMER_COUNT);
  });

  it("negative control: the consumer needle sees an ordinary import of the door", () => {
    // Without this, the pinned zero above would be reporting a broken needle rather
    // than an unrebound console, and the count would stay at zero — green, and
    // saying nothing — on the day the first surface starts calling the daemon.
    expect(CALL_DOOR_IMPORT.test(`import { callDaemon } from "../bridge/index.js";`)).toBe(true);
    expect(
      CALL_DOOR_IMPORT.test(
        ["import {", "  callDaemon,", "  type DaemonReply,", '} from "../bridge/index.js";'].join(
          "\n",
        ),
      ),
    ).toBe(true);
    // And not on the door merely named in prose, which is all the tree carries today.
    expect(CALL_DOOR_IMPORT.test("// a surface reaches the wire through `callDaemon`")).toBe(false);
    // The false-positive direction, which was unmeasured and live: this sentence
    // contains the word `import`, and the needle this replaces spanned the newlines
    // between the two words because nothing ended the statement in between.
    expect(
      CALL_DOOR_IMPORT.test(
        [
          "// a surface would import",
          "// `callDaemon` from the bridge door rather than reach the wire itself",
        ].join("\n"),
      ),
    ).toBe(false);
    // And a longer name that merely starts with the door's is a different symbol.
    expect(CALL_DOOR_IMPORT.test('import { callDaemonRegistry } from "./registry.js";')) //
      .toBe(false);
  });

  it("negative control: the chokepoint itself trips the scan", () => {
    // Without this, a typo in either pattern would make both clean results above
    // meaningless — the whole console would read as compliant because nothing
    // matched anywhere.
    expect(daemonCallReaches(readGovernedSource(CHOKEPOINT_MODULE))).toContain("called or aliased");
  });

  it("negative control: the needles separate a reach from a mention", () => {
    // The line the header draws, asserted against the predicate rather than
    // against whichever module happens to name the door in prose today.
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
    // needles: one bracket, and the whole scan reads the tree as compliant. A
    // module that smuggles a reply out this way holds an `unknown` it can cast,
    // which needs no validator, so the lint ban beside this scan does not cover it.
    expect(
      daemonCallReaches(`const reply = await bridge.sidekicks["daemon"].call(name, params);`),
    ).toStrictEqual(["namespace taken by computed key"]);
    expect(daemonCallReaches(`const door = bridge.sidekicks["daemon"];`)) //
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
  });
});

vi.setConfig({ testTimeout: ESLINT_CASE_BUDGET_MS });

async function restrictedImportMessages(
  source: string,
  filePath: string,
): Promise<readonly string[]> {
  return ruleMessagesAt(createDesktopLinter(), source, filePath, "no-restricted-imports");
}

const IMPORTS_ZOD = `import { z } from "zod";\nexport const schema = z;\n`;

describe("daemon-reply chokepoint — only the bridge family may hold a validator", () => {
  it("refuses `zod` in a console surface", async () => {
    const messages = await restrictedImportMessages(
      IMPORTS_ZOD,
      rendererProbePath("console", "workspace", "validator-probe.ts"),
    );
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.join("\n")).toContain("callDaemon");
  });

  it("refuses a `zod` SUBPATH too", async () => {
    // `no-restricted-imports` treats `zod` and `zod/v4` as distinct specifiers, so
    // a ban on the bare form alone is one import away from useless.
    const messages = await restrictedImportMessages(
      `import { z } from "zod/v4";\nexport const schema = z;\n`,
      rendererProbePath("console", "workspace", "validator-probe.ts"),
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("refuses `zod` in the shell subtree the console composes seats for", async () => {
    // Asserted synthetically because that subtree does not exist on this branch.
    // Without this case the second half of the `files` selector is untested, and a
    // typo there would be invisible until the subtree landed carrying a validator.
    const messages = await restrictedImportMessages(
      IMPORTS_ZOD,
      rendererProbePath("shell", "shell-probe.ts"),
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("allows it inside `console/bridge/`, which is where the schemas are bound", async () => {
    const messages = await restrictedImportMessages(
      IMPORTS_ZOD,
      rendererProbePath("console", "bridge", "validator-probe.ts"),
    );
    expect(messages).toHaveLength(0);
  });

  it("allows it in the wire-truth scenarios, which assert against the wire's shapes", async () => {
    const messages = await restrictedImportMessages(
      IMPORTS_ZOD,
      rendererProbePath("console", "bridge", "scenarios", "wire-truth", "probe.ts"),
    );
    expect(messages).toHaveLength(0);
  });

  it("keeps the renderer-untrusted ban the console block RESTATES", async () => {
    // The flat-config hazard made observable. A later matching object REPLACES a
    // rule's options wholesale, so the console block has to carry every entry the
    // renderer block carries; it spreads the hoisted arrays rather than copying
    // them, and this is what proves the spread is still there. Without it, a
    // refactor that dropped the spread would leave the console silently outside
    // the boundary and every zod case above would still pass.
    const messages = await restrictedImportMessages(
      [
        `import { ipcRenderer } from "electron";`,
        `import { join } from "node:path";`,
        `import { x } from "@ai-sidekicks/control-plane";`,
        `export const probe = { ipcRenderer, join, x };`,
        ``,
      ].join("\n"),
      rendererProbePath("console", "workspace", "boundary-probe.ts"),
    );
    expect(messages.join("\n")).toContain("Trust Stance");
    expect(messages.join("\n")).toContain("CP-003-3");
  });

  it("negative control: a NON-console renderer path may still import `zod`", async () => {
    // The ban is path-scoped, and it has to be: `packages/contracts` publishes
    // schemas and other plans' renderer subtrees are not bound by this chokepoint.
    // If this started failing, the `files` selector had been widened past the
    // console and the rule would be wrong in the other direction.
    const messages = await restrictedImportMessages(
      IMPORTS_ZOD,
      rendererProbePath("session-members", "validator-probe.ts"),
    );
    expect(messages).toHaveLength(0);
  });
});
