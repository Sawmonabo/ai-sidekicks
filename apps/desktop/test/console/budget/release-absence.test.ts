// Tier: bundle — what a RELEASE renderer build must not contain.
//
// `Spec-023 §Console Design (Meridian)` puts the fixture bridge, every scenario,
// and the scenario switcher behind `__SIDEKICKS_CONSOLE_FIXTURES__` so that Rollup
// collapses `if (false) { … }` and the bodies are PHYSICALLY ABSENT from a shipped
// bundle — not merely unreachable. The distinction is the whole point: unreachable
// code still ships a handle to the console's internals and a set of fabricated
// sessions to anyone who reads the file.
//
// The mechanism — that the assignment sits inside the guard — is a source-text claim
// review makes. This asserts the OUTCOME, against the artifact a person would actually
// install, because a define
// that was misspelled, dropped from one build mode, or defeated by a bundler
// setting would leave the mechanism intact and the outcome wrong.
//
// LIKE ITS NEIGHBOURS, THIS NEVER SKIPS. An absent build fails with the command
// that produces one. A grep that finds nothing because it was pointed at nothing
// is the exact false pass this file exists to prevent, which is also why the
// positive control below is not optional decoration.
//
// WHAT IT SWEEPS FOR, AND WHY IT DOES NOT NAME THE STRINGS ITSELF. The subject is
// `FIXTURE_GLOBAL_NAMES` — the closed tuple in `console/core/fixture-globals.ts`
// that every `define`-gated installer takes its own name from. Reading the same
// tuple the producers read is what keeps the set from going stale in the one
// direction that is invisible here: a fourth fixture global this file had never
// heard of would pass the sweep exactly as an absent one does. The leaf is
// imported directly rather than through `core/index.js` because a name is all this
// tier needs, and the three installers live in three families whose graphs reach
// React and the DOM — neither of which this Node-context project compiles with.
//
// THE SECOND SUBJECT: THE SCENARIO CORPUS ITSELF (2026-09-06). The fixture handle
// is the console's DOOR into the fixture, and sweeping for it caught a build that
// shipped the door. It did not catch the one that shipped the ROOM: every fixture
// global was absent from the release artifact while `"Browsing agent"`,
// `artifact-capture-staging-header`, `scenarios:`, and `fixtureServedOperations`
// were all present in it, because the `define` folds a fixture CALL SITE and does
// not remove the static import edge that reaches the corpus — and a module the graph
// still reaches keeps every top-level statement the bundler cannot prove pure, which
// a scenario built by calling builders at module scope never is.
// `electron.vite.config.ts` closes that with a path-scoped `moduleSideEffects`
// declaration, and this half is what stops the corpus coming back unnoticed.
//
// THE THIRD SUBJECT: AN OWNER-SLOT SHELL'S STYLESHEET (2026-09-06). The same lesson a
// third time, one layer out. Folding a slot's `__SIDEKICKS_CONSOLE_FIXTURES__` ternary
// removes the shell's JavaScript and says nothing about its RULES, which entered through
// the settings chunk root — not gated — as a bare side-effect import. Measured: a release
// renderer carried both shell sheets while carrying neither shell. The remedy is the
// package's own stylesheet rule rather than a build flag, and the sweep below is what
// keeps the sheet from drifting back onto an ungated root.
//
// THE FOURTH SUBJECT: THE GROWTH LEDGER'S SENTENCES (2026-09-09). Not a fixture this
// time, and that is what makes it a different failure. `GROWTH_OPERATIONS` is release
// code — `growth-refusals.ts` reads a row's `slateRow` to attribute every refusal a
// release build hands back — so no `define` gates it and no `moduleSideEffects`
// declaration can drop it. What is NOT release code is the sentence describing each
// operation: 145 of them, written for a reader of `Plan-023 §Console growth slate`,
// read by nothing a running console evaluates, and until this sweep landed they were
// carried on the row and therefore on the initial import graph. They now live in each
// plane's own `<PLANE>_GROWTH_OPERATION_SUMMARIES`, which the release build drops
// because nothing references it — a property of that arrangement rather than of a
// flag, and one a later diff undoes by putting a sentence back on a row, by giving the
// composition a module-level `const` initializer, or by having a shipped surface render
// one. Each of those is a real decision; none of them announces itself in a diff, and
// all three land here.
//
// THE MARKERS ARE READ FROM THE CORPUS, never written here, so a scenario a later
// family adds is swept the day it lands and no roster in this file goes stale. They are
// read from the corpus's SOURCE rather than imported from it, because this project's lib
// is Node's and a scenario module reaches the DOM — the same constraint the fixture-global
// import below is already written around. The growth ledger is the one subject IMPORTED
// rather than read: its modules reach types and a row constructor and nothing else, so
// this project compiles them, and the composition function is the same one the ledger's
// own pairing test drives.
//
// AND THAT READ IS WHY THE BUILT TREE IS WALKED NEXT DOOR. Reading the corpus means
// reaching renderer SOURCE, and a module which does that may not also walk a directory
// of its own — one admission for what counts as console source, and no second opinion
// drifting from it. Build output is a different subject with no such admission, so its
// walk lives in `built-renderer-tree.ts`, which reaches no renderer path at all.

import { join } from "node:path";

import ts from "typescript";

import { describe, expect, it } from "vitest";

import { FIXTURE_GLOBAL_NAMES } from "../../../src/renderer/src/console/core/fixture-globals.js";
import { growthOperationSummaries } from "../../../src/renderer/src/console/bridge/growth-operations/index.js";
import { readBuiltTextOrFailLoudly, type BuiltFile } from "./built-renderer-tree.js";
import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  consoleStylesheets,
  readConsoleSourceModule,
  toPosixSeparators,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * A string every console build contains, fixture or release.
 *
 * The positive control. Without it a misdirected read — an empty directory, a
 * renamed output path, a tree holding only source maps — would report the fixture
 * global absent because it was reading nothing at all.
 */
const CONSOLE_PRESENCE_MARKER = "meridian-frame";

/** Where the scenario corpus lives, as one directory this tier reads rather than imports. */
const SCENARIO_CORPUS_DIRECTORY: string = join(CONSOLE_DIRECTORY, "bridge", "scenarios");

/**
 * The scenario fields whose values make good markers, and which a scenario CO-DECLARES.
 *
 * The LABEL and the PURPOSE, and deliberately not the `id`. A scenario id is a short
 * lowercase word — `repos`, `browser`, `terminal`, `settings` — and every one of them is
 * also a route segment, a pane kind, or a sidebar section id that a release build
 * carries for its own reasons, so an id sweep fails on a clean bundle and would be
 * silenced rather than believed. The label and the purpose are prose written for the
 * scenario picker; nothing else in this console says "Browsing agent", and a bundle that
 * does is carrying the corpus.
 *
 * BOTH TOGETHER AS THE ANCHOR, not as a second chance (2026-09-07). The pair is the shape
 * `bridge/scenario-runtime/scenario.ts` declares: `ConsoleScenario` requires both, so an
 * object literal declaring both as siblings is a scenario, and one declaring a `label`
 * alone is somebody else's word. Sweeping every `label` in the directory swept
 * the WIRE's too: the corpus's `ProviderAccountUsageWindow` rows mirror the provider's
 * own limit labels, one of which is "Session" — a real product string five release
 * chunks carry for their own reasons, so a clean release build failed the sweep. The
 * fixture is right; the derivation was reading a field NAME and calling it prose. Both
 * fields are still swept, so a scenario that reworded one is caught by the other; what
 * no longer happens is either being swept alone.
 *
 * THE CO-DECLARATION RATHER THAN THE TYPE ANNOTATION, though both answer today's corpus
 * with the same markers. Anchoring on `: ConsoleScenario` would write a roster of one
 * type name into this file and miss the first scenario declared any other way — a
 * `satisfies`, an element of an array, a builder call — which is the direction of
 * staleness nothing here would report. The arrangement is a property of the corpus and
 * needs no name from this file. Its one boundary, stated rather than left to be
 * discovered: a literal inheriting `purpose` from a spread declares no pair, so a
 * scenario declares both fields or contributes neither.
 */
const SCENARIO_MARKER_FIELDS: readonly string[] = ["label", "purpose"];

/**
 * The name one object-literal member is declared under, or `undefined` for the rest.
 *
 * Shorthand and string-literal names are answered alongside identifiers because all
 * three are one declaration written three ways, and a rule seeing only identifiers would
 * let the other two past. A spread has no name and a computed one is not a name this
 * file can answer; both are "not a marker field", which is what the caller asks.
 */
function declaredMemberName(member: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) {
    return undefined;
  }
  const { name } = member;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/**
 * The markers one object literal contributes: its marker fields, or none at all.
 *
 * The pair test is about CO-DECLARATION and not about both values being literals. A
 * scenario whose `purpose` is composed from a constant still declares one, and its label
 * is still prose only the corpus has — so the sibling counts as present whatever it is
 * initialized to, and only string-literal values become markers to sweep for.
 */
function coDeclaredMarkersOf(literal: ts.ObjectLiteralExpression): readonly string[] {
  const declaredFields = new Set<string>();
  const markers: string[] = [];
  for (const member of literal.properties) {
    const memberName = declaredMemberName(member);
    if (memberName === undefined || !SCENARIO_MARKER_FIELDS.includes(memberName)) {
      continue;
    }
    declaredFields.add(memberName);
    if (ts.isPropertyAssignment(member) && ts.isStringLiteral(member.initializer)) {
      markers.push(member.initializer.text);
    }
  }
  return SCENARIO_MARKER_FIELDS.every((field) => declaredFields.has(field)) ? markers : [];
}

/**
 * Every marker one module's source text contributes, in declaration order.
 *
 * Split from the corpus walk so the planted control below drives the SAME derivation the
 * sweep drives — the reasoning {@link carriersOf} is already written under. A control
 * that re-expressed the co-declaration rule would prove only that the control implements
 * it.
 */
function markersInSourceText(fileName: string, sourceText: string): readonly string[] {
  const markers: string[] = [];
  forEachDescendant(parseSourceText(fileName, sourceText), (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      markers.push(...coDeclaredMarkersOf(node));
    }
  });
  return markers;
}

/**
 * Every marker the corpus contributes, read from its SOURCE rather than imported.
 *
 * IMPORTING `CONSOLE_SCENARIOS` WOULD BE THE OBVIOUS THING AND IT DOES NOT COMPILE. This
 * project is `tsconfig.test.json`, whose lib is Node's and carries no DOM — the same
 * constraint the fixture-global import above is written around — and a scenario module
 * reaches the console's store for its event types, which reaches the DOM. So the corpus
 * is read the way this tier reads everything else: off disk.
 *
 * Through the compiler's own parser rather than a regular expression, and through the
 * shared source reader in `console-source-modules.ts` rather than a second walk.
 * What it collects is the marker fields of every literal in that directory declaring
 * BOTH of them — every scenario, and a helper carrying the same pair, whose label is just
 * as much a string only the corpus has. A superset of the SCENARIOS is the safe direction
 * for an absence sweep; a superset of the DIRECTORY is not, because the corpus also holds
 * wire rows whose members are the product's own words.
 */
function scenarioCorpusMarkers(): readonly string[] {
  const markers = new Set<string>();
  for (const module of consoleSourceModules({ roots: [SCENARIO_CORPUS_DIRECTORY] })) {
    const text = readConsoleSourceModule(module);
    for (const marker of markersInSourceText(module.displayPath, text)) {
      markers.add(marker);
    }
  }
  return [...markers].sort();
}

const SCENARIO_CORPUS_MARKERS: readonly string[] = scenarioCorpusMarkers();

/**
 * Which stylesheets belong to a `define`-gated owner-slot shell.
 *
 * THE THIRD SUBJECT (2026-09-06), and it is the room again rather than the door. A
 * settings section whose body another plan authors carries a fixture SHELL behind
 * `__SIDEKICKS_CONSOLE_FIXTURES__`, and folding that ternary takes the shell's
 * JavaScript out of a release renderer. It did not take the shell's RULES: those
 * entered through `settings/settings-surface-body.ts` — the settings chunk root, which
 * is not gated — as a bare side-effect import, and a release renderer therefore shipped
 * the stylesheet for a subtree it does not contain. The remedy is structural rather
 * than a build flag, and it is `apps/desktop/AGENTS.md`'s own rule: each shell now
 * carries a sub-module door, the sheet enters through it, and the door is declared
 * side-effect-free in `electron.vite.config.ts` so it leaves with the shell it serves.
 * This is what stops it coming back.
 *
 * DERIVED FROM THE TREE RATHER THAN NAMED, on the corpus sweep's reasoning next door: a
 * roster of two written here would be two the day a third owner slot lands, and nothing
 * would report it. The predicate is the arrangement itself — a stylesheet under a
 * `shell/` directory inside `settings/pages/` — and the shared walk answers it, so no
 * second opinion about what console source is appears in this file.
 */
function ownerSlotShellStylesheets(): readonly ConsoleSourceModule[] {
  return consoleStylesheets({ roots: [CONSOLE_DIRECTORY] }).filter((stylesheet) => {
    const path = toPosixSeparators(stylesheet.relativePath);
    return path.startsWith("settings/pages/") && path.includes("/shell/");
  });
}

/**
 * Every class root those stylesheets style, as the marker to sweep for.
 *
 * The BLOCK root and never a whole selector: each shell sheet's own header states that
 * nothing outside its `meridian-<block>__` prefix appears in it, so the prefix is both
 * the sheet's subject and the string no other console stylesheet writes. Read from the
 * line-anchored selectors, which is where a rule opens — a root mentioned only inside a
 * descendant selector belongs to the sheet that declares it, and sweeping for that one
 * would fail on a clean build.
 */
function ownerSlotShellClassRoots(): readonly string[] {
  const roots = new Set<string>();
  for (const stylesheet of ownerSlotShellStylesheets()) {
    const text = readConsoleSourceModule(stylesheet);
    for (const match of text.matchAll(/^\.(meridian-[a-z0-9-]+)__/gmu)) {
      const [, classRoot] = match;
      if (classRoot !== undefined) {
        roots.add(`${classRoot}__`);
      }
    }
  }
  return [...roots].sort();
}

const OWNER_SLOT_SHELL_CLASS_ROOTS: readonly string[] = ownerSlotShellClassRoots();

/**
 * Every sentence the growth ledger carries, read through the composition itself.
 *
 * The one subject here obtained by IMPORT. A sentence is prose written for a reader of
 * the plan, so the values are the markers with no derivation in between — and reading
 * them through `growthOperationSummaries()` is what keeps the set from going stale in
 * the direction nothing else would report: a plane a later family adds is swept the day
 * its rows land, because that composition is annotated over the whole operation id
 * union and would not compile without them.
 */
const GROWTH_LEDGER_SENTENCES: readonly string[] = Object.values(growthOperationSummaries());

/**
 * Which sentences a built tree carries, and where.
 *
 * ONE PASS REPORTING EVERY LEAK rather than a case per sentence. The subject is a
 * property of the arrangement — a sentence is back on a row, or the composition became
 * a module-level `const`, or a surface renders one — and each of those puts the whole
 * ledger back at once, so 145 red cases would say one thing 145 times. What a reader
 * needs is which sentences and which chunk, which is what this returns.
 */
function ledgerSentenceCarriers(
  sentences: readonly string[],
  files: readonly BuiltFile[],
): readonly string[] {
  return sentences.flatMap((sentence) =>
    carriersOf(sentence, files).map((relativePath) => `${relativePath}: ${sentence.slice(0, 60)}…`),
  );
}

/**
 * Which built files carry a marker.
 *
 * A named function rather than a filter written twice, because the planted negative
 * control below has to drive the SAME predicate the sweep does — a control that
 * re-expressed the search would prove only that the control works.
 */
function carriersOf(marker: string, files: readonly BuiltFile[]): readonly string[] {
  return files.filter((file) => file.text.includes(marker)).map((file) => file.relativePath);
}

describe("release bundle — the fixture surface is absent, not merely unreachable", () => {
  const builtFiles = readBuiltTextOrFailLoudly();

  it("positive control: the sweep is reading a real console build", () => {
    // An absence claim is only as good as the evidence that the search happened.
    // This is the control for the test below rather than a fact worth asserting
    // on its own, and it runs first so a misdirected read is reported as "read
    // nothing" rather than as "shipped nothing".
    const carriers = carriersOf(CONSOLE_PRESENCE_MARKER, builtFiles);
    expect(
      carriers.length,
      `no built file mentions "${CONSOLE_PRESENCE_MARKER}", so the absence claim below would be vacuous`,
    ).toBeGreaterThan(0);
  });

  it.each(FIXTURE_GLOBAL_NAMES)("does not ship the fixture handle %s", (fixtureGlobalName) => {
    const carriers = carriersOf(fixtureGlobalName, builtFiles);
    expect(
      carriers,
      `"${fixtureGlobalName}" reached the built tree. Either the assignment left its ` +
        "`__SIDEKICKS_CONSOLE_FIXTURES__` guard, or `out/renderer` currently holds a " +
        "fixtures build — `pnpm build:fixtures` and `pnpm build` write the same directory. " +
        "Re-run `pnpm --filter @ai-sidekicks/desktop build` and try again.",
    ).toStrictEqual([]);
  });

  it("positive control: the corpus sweep has scenarios to look for", () => {
    // The markers are derived, so an empty derivation would make every case below
    // vacuous without failing any of them. This is the one assertion that catches a
    // corpus that stopped exporting scenarios rather than one that stopped shipping.
    expect(SCENARIO_CORPUS_MARKERS.length).toBeGreaterThan(0);
  });

  it.each(SCENARIO_CORPUS_MARKERS)("does not ship the scenario marker %s", (marker) => {
    const carriers = carriersOf(marker, builtFiles);
    expect(
      carriers,
      `"${marker}" reached the built tree, so a release bundle carries the fixture ` +
        "scenario corpus. Either `out/renderer` currently holds a fixtures build — " +
        "`pnpm build:fixtures` and `pnpm build` write the same directory — or the " +
        "`treeshake.moduleSideEffects` declaration in `electron.vite.config.ts` no " +
        "longer covers the module this string came from. The `define` guard alone " +
        "does not remove a static import edge; both halves are needed.",
    ).toStrictEqual([]);
  });

  it("positive control: the shell sweep has stylesheets and class roots to look for", () => {
    // Two derivations, and either one going empty makes every case below vacuous
    // without failing one. The sheets are asserted separately from the roots because
    // the two fail for different reasons — a moved directory empties the first, a
    // renamed block prefix empties the second — and a single count would report the
    // wrong one.
    expect(ownerSlotShellStylesheets().length).toBeGreaterThan(0);
    expect(OWNER_SLOT_SHELL_CLASS_ROOTS.length).toBeGreaterThan(0);
  });

  it.each(OWNER_SLOT_SHELL_CLASS_ROOTS)("does not ship the shell class root %s", (classRoot) => {
    const carriers = carriersOf(classRoot, builtFiles);
    expect(
      carriers,
      `"${classRoot}" reached the built tree, so a release renderer carries the rules ` +
        "for an owner-slot fixture shell it does not contain. Either `out/renderer` " +
        "currently holds a fixtures build — `pnpm build:fixtures` and `pnpm build` write " +
        "the same directory — or the sheet has left its shell's sub-module door and is " +
        "being imported from a module the `__SIDEKICKS_CONSOLE_FIXTURES__` fold does not " +
        "remove. Both halves are needed: the door owns the sheet, and " +
        "`electron.vite.config.ts` declares the door's directory side-effect-free.",
    ).toStrictEqual([]);
  });

  it("negative control: the corpus sweep reports a carrier when one is planted", () => {
    // Every case above is an absence claim, and an absence claim is only worth what
    // its search is worth. This plants a file that DOES carry a scenario marker and
    // drives the same `carriersOf` the sweep drives, so a predicate that had stopped
    // matching — a read that returned no text, a comparison that stopped comparing —
    // is reported here instead of being read as a clean release build.
    const plantedMarker = SCENARIO_CORPUS_MARKERS[0];
    expect(plantedMarker).toBeDefined();
    const plantedFiles: readonly BuiltFile[] = [
      { relativePath: "assets/clean.js", text: "export const nothingToSeeHere=1;" },
      { relativePath: "assets/planted.js", text: `const s={id:"${plantedMarker ?? ""}"};` },
    ];

    expect(carriersOf(plantedMarker ?? "", plantedFiles)).toStrictEqual(["assets/planted.js"]);
  });

  it("positive control: the ledger sweep has sentences to look for", () => {
    // The markers are composed rather than listed, so an empty composition would make
    // the case below vacuous without failing it. This is the assertion that catches a
    // ledger that stopped carrying sentences rather than a build that stopped shipping
    // them, and it is the one that fires if the composition is ever narrowed.
    expect(GROWTH_LEDGER_SENTENCES.length).toBeGreaterThan(0);
  });

  it("does not ship the growth ledger's sentences", () => {
    expect(
      ledgerSentenceCarriers(GROWTH_LEDGER_SENTENCES, builtFiles),
      "a release renderer carries the growth ledger's operation sentences, which no " +
        "running console reads. Either `out/renderer` currently holds a fixtures build " +
        "— `pnpm build:fixtures` and `pnpm build` write the same directory — or a " +
        "sentence has moved back onto the row `growth-refusals.ts` reads, or " +
        "`growthOperationSummaries` became a module-level `const` whose initializer the " +
        "bundler cannot prove pure, or a shipped surface began rendering one. The first " +
        "three put the whole ledger back on the initial graph; the last is a decision " +
        "to make deliberately, and to record beside the table.",
    ).toStrictEqual([]);
  });

  it("negative control: the ledger sweep reports a carrier when one is planted", () => {
    // The absence claim above is worth exactly what its search is worth, and this drives
    // the same `carriersOf` through the same reading. A predicate that had stopped
    // matching — a composition returning nothing, a read that returned no text — is
    // reported here instead of being read as a clean release build.
    const [plantedSentence] = GROWTH_LEDGER_SENTENCES;
    expect(plantedSentence).toBeDefined();
    const plantedFiles: readonly BuiltFile[] = [
      { relativePath: "assets/clean.js", text: "export const nothingToSeeHere=1;" },
      {
        relativePath: "assets/planted.js",
        text: `const row={summary:"${plantedSentence ?? ""}"};`,
      },
    ];

    expect(ledgerSentenceCarriers([plantedSentence ?? ""], plantedFiles)).toStrictEqual([
      `assets/planted.js: ${(plantedSentence ?? "").slice(0, 60)}…`,
    ]);
  });

  it("negative control: a marker needs both fields co-declared on one literal", () => {
    // The planted control one step earlier, over what the sweep is handed to look FOR
    // rather than over how it looks. It drives the same derivation the corpus is read
    // through, against a module holding one literal of each shape: a wire row carrying
    // a `label` the product legitimately ships, and a scenario carrying the pair. A
    // rule that widened back to every `label` in the directory is reported here — as a
    // marker set holding the product's own word — instead of next door, as a clean
    // release build accused of shipping the corpus.
    const planted = markersInSourceText(
      "planted.ts",
      [
        'const wireRow = { limitId: "weekly_all", label: "PLANTED WIRE LABEL" };',
        'const scenario = { id: "p", label: "PLANTED LABEL", purpose: "PLANTED PURPOSE" };',
      ].join("\n"),
    );

    expect(planted).toStrictEqual(["PLANTED LABEL", "PLANTED PURPOSE"]);
  });
});
