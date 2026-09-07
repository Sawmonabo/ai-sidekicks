// The daemon-reply chokepoint, asserted from both sides.
//
// THE CLAIM. Every daemon reply the console reads is parsed against the shape the
// corpus registers for that method, because there is exactly one module that
// reaches the bridge's call door — `console/bridge/daemon/daemon-reply.ts` — and exactly
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
// AND ONE CENSUS, BECAUSE THE CALL SIDE IS VACUOUS OVER AN EMPTY SET. "No module
// outside the bridge family reaches it" reports compliance over a console where
// nothing calls the daemon at all, and cannot be told apart from "every caller goes
// through the door", which is what this file's title claims. The consumer count is
// therefore PINNED rather than left implicit — see `CALL_DOOR_CONSUMER_COUNT`, which
// also fails on a surface quietly LEAVING the door.
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
//   • Nothing. The `shell/` subtree IS scanned — the package's own structure rules
//     place it beside the console as a `console-unit` resident, and three of the
//     eleven modules that consume the call door live in it.

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
import { daemonCallReaches, importsCallDoor } from "./daemon-call-census.js";

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
 * The roots are the shared walk's default, `console/` and `shell/`, and the vacuity
 * guard below is what keeps a wrong root from turning into a silent pass.
 */
const GOVERNED_MODULES: readonly ConsoleSourceModule[] = consoleSourceModules({ tests: true });

/**
 * The one production module allowed to reach the bridge's call door.
 *
 * A path rather than a naming convention, so moving the chokepoint is an edit a
 * reviewer sees in this file.
 */
const CHOKEPOINT_MODULE = "console/bridge/daemon/daemon-reply.ts";

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
 * THIRTEEN, and PINNED rather than left as a floor. The count was zero when this gate
 * landed, and zero was the whole reading then: the two reach claims above are
 * satisfied by an empty set, so a scan reporting the tree compliant because nothing
 * called the daemon at all was not making the claim this file's title makes.
 *
 * It is no longer vacuous. The thirteen, by module and by the family that bound it:
 *
 *   1. `shell/composer/router/send-dispatch.ts` — the send dispatch. Named by its
 *      module rather than as "the send router": the router was split and imports the
 *      door nowhere, so a reader reconciling this number against the tree would have
 *      gone looking in the wrong file.
 *   2. `shell/composer/accessories/compaction/compaction-dispatch.ts` — the compaction
 *      dispatch.
 *   3. `shell/composer/commands/provider-command-read.ts` — the provider-command read.
 *   4. `console/runs/pane/controls/run-control-dispatch.ts` — the runs pane's
 *      run-control dispatch.
 *   5. `console/runs/pane/controls/StepIn.tsx` — its step-in control.
 *   6. `console/agents/run-console/agent-console-reads.ts` — the agent console's reads.
 *   7. `console/collaboration/channels/channel-model.ts` — the channel model.
 *   8. `console/collaboration/mutation-coordinator.ts` — the collaboration mutations.
 *   9. `console/collaboration/members/presence-model.ts` — the presence model.
 *  10. `console/settings/pages/mounts/mount-inventory.ts` — the mount inventory.
 *  11. `console/repos/repo-reads.ts` — the repos family's five `repo.*` reads. It used
 *      to reach `daemon.call` itself and hold its own parser and its own two refusal
 *      codes beside it, and it now names five registry keys and holds none of the
 *      three.
 *  12. `console/sessions/acts/JoinSessionForm.tsx` — the sessions destination's join.
 *      The first surface to bind `session.join`: the shipped Tier-1 probe calls it
 *      from a mount effect through the raw bridge, and a form a person fills in is a
 *      different act from a probe that joins on being rendered.
 *  13. `console/onboarding/provider-readiness/provider-readiness.ts` — the
 *      onboarding walkthrough's provider-readiness step, which reads the account
 *      plane's `providerAccount.list` readiness projection and re-probes one account
 *      through `providerAccount.probe`.
 *      It is a VIEW over that plane and mints nothing: registration and defaults stay
 *      the settings page's, so the two reads are the whole of its reach.
 *
 * Every surface in these families that reaches the wire, each through `callDaemon` and
 * none around it. The composer's half was six until its target chip stopped taking a
 * `providerAccount.list` of its own to join a paying account's label: that registry is
 * node-scoped and `console/bridge/quotas/provider-account-quota.ts` already reads it
 * once per window, so the label rows are folded off that reading and the chip joins
 * them.
 *
 * The pin stays because the reading it protects is unchanged in the other direction:
 * a surface that stopped going through the door would drop this number, and one that
 * started reaching past it would be caught by the reach scan above rather than here.
 * It fails the moment the number moves either way, so the lane that binds the next
 * surface moves this constant in its own PR and a reader learns from that diff that
 * the console grew a wire — and a surface QUIETLY LEAVING the door, which is the
 * regression this pin exists for, fails it just as loudly.
 */
const CALL_DOOR_CONSUMER_COUNT = 13;

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
      .map((module) => ({ module, reaches: daemonCallReaches(readGovernedSource(module), module) }))
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
      .map((module) => ({ module, reaches: daemonCallReaches(readGovernedSource(module), module) }))
      .filter((entry) => entry.reaches.length > 0)
      .map((entry) => `${entry.module}: ${entry.reaches.join(", ")}`);

    expect(offenders).toStrictEqual([]);
  });

  it("counts what consumes the call door, against a pinned number", () => {
    const consumers = modules
      .filter((module) => !isBridgeFamilyModule(module))
      .filter((module) => importsCallDoor(readGovernedSource(module), module));

    expect(
      consumers.length,
      `modules importing the call door: ${consumers.join(", ") || "none"}`,
    ).toBe(CALL_DOOR_CONSUMER_COUNT);
  });

  it("negative control: the consumer needle sees an ordinary import of the door", () => {
    // Without this, the pinned count above would be reporting a broken needle rather
    // than the tree, and a needle that matched nothing would read the console as
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
    // Asserted over a probe path rather than over a real module, because the claim
    // is about the `files` selector and not about what the subtree happens to hold:
    // no module there imports `zod` today, so a typo in that half of the selector
    // would be invisible until one did.
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
