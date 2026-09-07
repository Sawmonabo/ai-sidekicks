// The byte-scaling chokepoint, asserted.
//
// `Spec-023 §Console Design (Meridian)` §The eight rules holds the console to
// `Intl` for every derived quantity, and `primitives/wire-figures.ts` carries the
// single amendment to that rule: `Intl` has no kibibyte, so exactly one function
// scales by powers of 1024 and appends a label from a closed set. That module's
// header states this test exists and says what it asserts. Until this file it did
// not, so the one written claim standing between the console and a second byte
// formatter was a comment describing a test nobody had written — and `apps/desktop`
// AGENTS.md names "no second byte formatter" a chokepoint precisely because the
// second one is never introduced deliberately. It arrives as four lines in a
// component that needed a file size on screen.
//
// WHAT COUNTS AS SCALING, and why the line is drawn where it is. A binary unit
// LABEL is the giveaway: a module that scales bytes has to name the unit it scaled
// to, and a module that merely bounds a byte count does not. That is why
// `core/constants.ts` may hold `64 * 1024` — a cap is a bound, it names no unit,
// and nothing renders it — while `/ 1024` is flagged, because dividing is the
// scaling step itself. Multiplying up to a bound and dividing down to a display
// figure are different acts, and only one of them is this chokepoint's business.
//
// Test files are excluded: a test asserting that "1.0 KiB" renders has to write
// "1.0 KiB", and forbidding that would forbid testing the chokepoint's own output.
//
// THE SECOND CLAIM: THE PLANE THAT SPEAKS FOR THE SHELL PUTS NO REPORTED VALUE INTO
// PROSE. Byte scaling is one way to format a wire value outside the chokepoint and
// interpolation is the other, and the second is the one that arrives without anybody
// deciding to format anything: a sentence needs a version in it, so the version goes
// in the template. That is how both protocol versions and both ladder counters reached
// the screen as proportional prose — no mono signature, no `Intl`, and no element to
// hang either on. The repair was a sentence MODEL with figure slots, and this is what
// keeps it: a member of the shell's report inside a `${…}` fails here.
//
// SCOPED TO `frame/shell-state/`, WHICH IS A DIRECTORY AND NOT A NAMING CONVENTION.
// The tree's other copy modules are announcement text — a live region is handed a
// string, and an `Intl`-formatted number inside one is the only form a spoken sentence
// can take — so a rule keyed on `*-copy.ts` would fail modules that have no element to
// reach for. This plane's sentences are all rendered, so every figure in one has an
// element available, and that is what makes the claim true here. Extending it to
// another rendered plane is an ordinary widening of the needle list below.

import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";

/**
 * The one module allowed to scale a byte figure.
 *
 * An allow-list of exactly one, written as a path rather than inferred from a
 * naming convention, so moving the chokepoint is an edit a reviewer sees.
 */
const CHOKEPOINT_MODULE = "console/primitives/wire-figures.ts";

/**
 * The binary unit labels. Naming one of these in a source module is the
 * observable signature of having scaled a byte count for display.
 */
const BINARY_UNIT_LABELS: readonly string[] = ["KiB", "MiB", "GiB", "TiB"];

/**
 * The scaling step, in the forms it can be written.
 *
 * Division only. See the header: multiplying by 1024 bounds a value, dividing by
 * it converts one for a reader.
 */
const SCALING_STEP_FORMS: readonly string[] = [
  "/ 1024",
  "/= 1024",
  "/ BYTE_UNIT_STEP",
  "/= BYTE_UNIT_STEP",
];

/**
 * Every way `source` shows it scaled a byte figure, or `[]`.
 *
 * A pure function over text rather than a loop inside a test, so the negative
 * controls below can drive it with strings whose verdict is known and the checker
 * is proved to bite without perturbing a real module.
 */
function byteScalingSignatures(source: string): readonly string[] {
  return [...BINARY_UNIT_LABELS, ...SCALING_STEP_FORMS].filter((form) => source.includes(form));
}

/** The directory whose sentences are all rendered, and so may embed no report value. */
const SENTENCE_PLANE_PREFIX = "console/frame/shell-state/";

/**
 * The members the shell's report carries, each a value the supervisor supplied.
 *
 * Taken from `store/shell-state.ts`'s `ShellNegotiation` and `ShellConnection`: the
 * three the negotiation types "verbatim" plus the ladder's own counters, the last
 * error, and the heartbeat stamp. Every one of them is a figure by rule 4's two
 * classes, and none of them is a word this console wrote.
 */
const SHELL_REPORT_MEMBERS: readonly string[] = [
  "attempt",
  "attemptLimit",
  "consoleProtocolVersion",
  "daemonProtocolVersion",
  "daemonSupportedProtocols",
  "lastError",
  "lastHeartbeatAt",
];

/**
 * Every report member `source` puts inside a template interpolation, or `[]`.
 *
 * The interpolation is what makes it PROSE. Reading a member into a local, passing one
 * to a figure slot, or comparing two is ordinary code and is not this rule's business;
 * `${…}` around one is the module deciding how that value reads, which is the decision
 * `primitives/wire-figures.ts` owns.
 */
function proseEmbeddedReportMembers(source: string): readonly string[] {
  return [...source.matchAll(/\$\{[^}]*\}/gu)].flatMap((interpolation) =>
    SHELL_REPORT_MEMBERS.filter((member) => interpolation[0].includes(member)),
  );
}

describe("wire-figure-formatting — byte scaling happens in exactly one module", () => {
  // The walk is `test/console/console-source-modules.ts`, shared with the timer and
  // windowed-row tripwires: three copies of "what counts as console source" is how
  // one scan comes to read declaration files and another does not, with nothing
  // reporting the difference. Scoped to the console root, because this chokepoint's
  // claim is about the console and not about every renderer subtree.
  const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

  it("finds a console tree to scan at all", () => {
    // Without this, a wrong CONSOLE_DIRECTORY would scan nothing and every
    // assertion below would pass over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules.map((module) => module.displayPath)).toContain(CHOKEPOINT_MODULE);
  });

  it("no other module names a binary unit or divides by the scaling step", () => {
    const offenders = modules
      .filter((module) => module.displayPath !== CHOKEPOINT_MODULE)
      .map((module) => ({
        module: module.displayPath,
        signatures: byteScalingSignatures(readConsoleSourceModule(module)),
      }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${entry.module}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the chokepoint itself trips every signature", () => {
    // The checker reads real files and the needles match real code. Without this,
    // a typo in a needle would make the clean result above meaningless.
    const chokepoint = moduleNamed(modules, CHOKEPOINT_MODULE, "the byte-scaling chokepoint");
    const signatures = byteScalingSignatures(readConsoleSourceModule(chokepoint));
    for (const label of BINARY_UNIT_LABELS) {
      expect(signatures).toContain(label);
    }
    // The division form is asserted as a CLASS, not as one spelling: the module
    // writes `scaled /= BYTE_UNIT_STEP`, and pinning `/ BYTE_UNIT_STEP` here made
    // this control fail against a chokepoint that was doing exactly its job.
    expect(SCALING_STEP_FORMS.filter((form) => signatures.includes(form))).not.toStrictEqual([]);
  });

  it("negative control: a byte cap is not scaling, and a unit label is", () => {
    // The two sides of the line the header draws, asserted against the predicate
    // rather than against whichever module happens to hold a cap today.
    expect(byteScalingSignatures("export const CAP: number = 64 * 1024;")).toStrictEqual([]);
    expect(byteScalingSignatures('const label = "KiB";')).toStrictEqual(["KiB"]);
    expect(byteScalingSignatures("const scaled = total / 1024;")).toStrictEqual(["/ 1024"]);
  });
});

describe("wire-figure-formatting — the shell's sentences embed no reported value", () => {
  const planeModules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] }).filter((module) =>
    module.displayPath.startsWith(SENTENCE_PLANE_PREFIX),
  );

  it("finds the sentence plane at all", () => {
    // Without this a renamed directory would scan nothing and the claim below would
    // pass over the empty set — which is exactly how a chokepoint goes quiet.
    expect(planeModules.map((module) => module.displayPath)).toContain(
      `${SENTENCE_PLANE_PREFIX}shell-sentences.ts`,
    );
    expect(planeModules.length).toBeGreaterThan(3);
  });

  it("puts no member of the shell's report inside a template", () => {
    const offenders = planeModules
      .map((module) => ({
        module: module.displayPath,
        members: proseEmbeddedReportMembers(readConsoleSourceModule(module)),
      }))
      .filter((entry) => entry.members.length > 0)
      .map((entry) => `${entry.module}: ${entry.members.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the sentences this rule was written against still trip it", () => {
    // The two forms the plane actually carried, planted verbatim. Without this the
    // clean result above would pass for a needle list that matched nothing at all.
    expect(
      proseEmbeddedReportMembers(
        "return `This console speaks ${negotiation.consoleProtocolVersion};" +
          " the local runtime answered ${negotiation.daemonProtocolVersion}.`;",
      ),
    ).toStrictEqual(["consoleProtocolVersion", "daemonProtocolVersion"]);
    expect(
      proseEmbeddedReportMembers(
        "return `Reconnecting — attempt ${String(connection.attempt)}" +
          " of ${String(connection.attemptLimit)}.`;",
      ),
    ).toStrictEqual(["attempt", "attempt", "attemptLimit"]);
    expect(
      proseEmbeddedReportMembers(
        '`The runtime supports ${negotiation.daemonSupportedProtocols.join(", ")}.`',
      ),
    ).toStrictEqual(["daemonSupportedProtocols"]);
  });

  it("negative control: reading a member is not putting one into prose", () => {
    // The other side of the line the header draws. A module that takes the value and
    // hands it to a figure slot is doing exactly what the repair asks for, and a rule
    // that flagged it would have no repair left to offer.
    expect(
      proseEmbeddedReportMembers(
        'return [words("speaks "), figure(negotiation.daemonProtocolVersion)];',
      ),
    ).toStrictEqual([]);
    expect(proseEmbeddedReportMembers("const attempt = connection.attempt;")).toStrictEqual([]);
  });
});
