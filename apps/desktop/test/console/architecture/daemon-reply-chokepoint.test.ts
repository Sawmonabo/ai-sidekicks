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
// The reach and consumption needles live in `daemon-call-census.ts` beside this file
// and are driven by `daemon-call-census.test.ts` beside that, on the `barrel-census.ts`
// pattern: this file is the rule applied to the real tree, those two are the rule and
// its bench. What stays here is the pair of assertions that read the real console — the
// clean sweep, and the one module that has to trip it — because a needle case writes a
// source this tree does not contain and cannot be written against it.
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
//     fourteen modules that consume the call door live in it.

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
import { importsCallDoor } from "./daemon-call-census.js";
import { daemonCallReaches } from "./daemon-reach-forms.js";

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
 * How many modules outside the bridge family consume the call door on this branch —
 * importing its own name, or reading it off a namespace they imported, which
 * `daemon-call-census.ts` reads as one act in two spellings.
 *
 * TWENTY-TWO, and PINNED rather than left as a floor. The count was zero when this gate
 * landed, and zero was the whole reading then: the two reach claims above are
 * satisfied by an empty set, so a scan reporting the tree compliant because nothing
 * called the daemon at all was not making the claim this file's title makes.
 *
 * It is no longer vacuous. The twenty-two, by module and by the family that bound it:
 *
 *   1. `shell/composer/router/send-dispatch.ts` — the send dispatch. Named by its
 *      module rather than as "the send router": the router was split and imports the
 *      door nowhere, so a reader reconciling this number against the tree would have
 *      gone looking in the wrong file.
 *   2. `shell/composer/accessories/compaction/compaction-dispatch.ts` — the compaction
 *      dispatch.
 *   3. `shell/composer/commands/provider-command-read.ts` — the provider-command read.
 *   4. `console/runs/pane/controls/run-control-dispatch.ts` — the runs pane's
 *      run-control dispatch, for all six controls and BOTH of their entry points.
 *   5. `console/agents/run-console/agent-console-reads.ts` — the agent console's reads.
 *   6. `console/collaboration/channels/channel-model.ts` — the channel model.
 *   7. `console/collaboration/invites/CreateInvite.tsx` — the invite mint's
 *      `invite.create`, the first binding of that verb. It sits here beside the
 *      ledger's revoke because the two are two acts on two rows and not one
 *      coordinator over an invite family — the same reason entry 9 gives.
 *   8. `console/collaboration/invites/SentInvites.tsx` — the sent-invite ledger's
 *      `invite.revoke`.
 *   9. `console/collaboration/members/Memberships.tsx` — the membership ledger's
 *      `membership.update`, behind all four of its controls. TWO ENTRIES FOR ONE
 *      FAMILY'S MUTATIONS AND NOT ONE COORDINATOR: the shared coordinator used to hold
 *      the door call behind a binder generic over both methods, which put ONE call
 *      site in the source for two verbs at once. One call site naming one method is
 *      what lets `read-signal-chokepoint.test.ts` read a deliberate absence of a
 *      cancellation signal as deliberate, so the dispatch sits at the surface that
 *      names a method and the coordinator keeps the single-flight rule it owns.
 *  10. `console/collaboration/members/presence-model.ts` — the presence model.
 *  11. `console/settings/pages/mounts/mount-inventory.ts` — the mount inventory.
 *  12. `console/repos/repo-reads.ts` — the repos family's five `repo.*` reads. It used
 *      to reach `daemon.call` itself and hold its own parser and its own two refusal
 *      codes beside it, and it now names five registry keys and holds none of the
 *      three.
 *  13. `console/browser/pane/file/file-boundary.ts` — the browser pane's admitted-root
 *      read. The pane's file control has to say which roots a local file may come
 *      from before a person picks one, and the trust envelope is the daemon's: a
 *      renderer that answered from anything else would be deriving the eligibility
 *      the refusal it renders exists to report.
 *  14. `console/sessions/acts/JoinSessionForm.tsx` — the sessions destination's join.
 *      The first surface to bind `session.join`: the shipped Tier-1 probe calls it
 *      from a mount effect through the raw bridge, and a form a person fills in is a
 *      different act from a probe that joins on being rendered.
 *  15. `console/onboarding/provider-readiness/provider-readiness.ts` — the
 *      onboarding walkthrough's provider-readiness step, which reads the account
 *      plane's `providerAccount.list` readiness projection.
 *      It is a VIEW over that plane and mints nothing: registration and defaults stay
 *      the settings page's, so that read and the probe below are the whole of its
 *      family's reach.
 *  16. `console/onboarding/provider-readiness/provider-readiness-acts.ts` — the same
 *      step's two mutations, which re-probe ONE account through
 *      `providerAccount.probe`. TWO ENTRIES FOR ONE STEP AND NOT A WIDENED FIFTEENTH:
 *      the step's reading and the acts over it are two modules because they are two
 *      jobs, and a census that folded them would report one consumer for a directory
 *      where either half could quietly leave the door.
 *  17. `console/workspace/new-session/new-session-send.ts` — the new-session send: the
 *      draft module composes the request and imports the door nowhere, so the one
 *      module here is the one that dispatches it.
 *  18. `console/ledger/cards/shell/shell-row-reads.ts` — the two calls the ledger's
 *      fixture shell rows make: the run-scoped reasoning-surface read a reasoning row
 *      offers, and the answer an input-ask row delivers. It dies with the shell, and
 *      the change that deletes that directory moves this number back down.
 *  19. `console/ledger/structure/child-runs/child-run-expansion.ts` — the child-run
 *      expansion's own read.
 *  20. `console/workspace/deck/take-the-floor.ts` — the deck's half of "Step in": the
 *      execution-root read that names which checkout a run created. The repos family
 *      reads that registry too, and is a sibling this one may not import.
 *  21. `console/workspace/sidebar/bulk/bulk-acts.ts` — the sidebar's bulk act table. It
 *      is the one module that names all three bulk verbs, and it names them as LITERALS
 *      so each request keeps the type the method fixes — a table holding the method as
 *      data would have to widen every request to `unknown`, which is the check the door
 *      exists to make.
 *  22. `console/ledger/frame/paging/earlier-window-reader.ts` — the backward walk into
 *      the rows below the window's head. The only read here that grows the log at the
 *      END the stream does not append to, and the one place `timeline.read` is sent
 *      from: the store owns where the page lands and this owns where the next one
 *      starts.
 *
 * Every surface in these families that reaches the wire, each through `callDaemon` and
 * none around it. TWICE now the number has come DOWN because a surface stopped taking
 * a `providerAccount.list` of its own: the composer's half was six until its target
 * chip joined the node's reading for a paying account's label, and the settings
 * accounts shell was the twelfth row until it did the same for the registry it
 * renders. That registry is node-scoped and `console/bridge/quotas/`
 * `provider-account-quota.ts` already reads it once per window behind the one
 * `providerAccount.subscribe` this console opens, so a second reader was a second
 * snapshot of one node's accounts with nothing on screen saying the two disagreed.
 *
 * Two more modules NAME the door in prose and are deliberately not among them:
 * `workspace/new-session/NewSessionControl.tsx` and the send module's own test both
 * describe what `callDaemon` answers, and the needle below separates an import clause
 * from a sentence.
 *
 * The runs half was two until `console/runs/pane/controls/StepIn.tsx` stopped sending
 * its own `run.pause`. It held a second single-flight latch beside the surface's, so
 * the button and the palette's row for the same control each admitted while the other
 * was settling — two idempotency keys against one run version, which the wire reads as
 * two distinct mutations rather than replays of one. It now dispatches through
 * `RunControlSurface`, which is entry #4, so this number FALLING is what that fix looks
 * like from here. It read eleven again rather than ten because
 * `console/browser/pane/file/file-boundary.ts` landed in the same window — two
 * independent moves that happen to cancel, which is exactly why the pin is re-derived
 * by counting the enumeration above and never carried forward, and why that entry is
 * named by its module rather than by an ordinal a later insertion would move.
 *
 * The pin stays because the reading it protects is unchanged in the other direction:
 * a surface that stopped going through the door would drop this number, and one that
 * started reaching past it would be caught by the reach scan above rather than here.
 * It fails the moment the number moves either way, so the lane that binds the next
 * surface moves this constant in its own PR and a reader learns from that diff that
 * the console grew a wire — and a surface QUIETLY LEAVING the door, which is the
 * regression this pin exists for, fails it just as loudly.
 */
const CALL_DOOR_CONSUMER_COUNT = 22;

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

  it("negative control: the chokepoint itself trips the scan", () => {
    // Without this, a typo in either pattern would make both clean results above
    // meaningless — the whole console would read as compliant because nothing
    // matched anywhere.
    expect(daemonCallReaches(readGovernedSource(CHOKEPOINT_MODULE))).toContain("called or aliased");
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
