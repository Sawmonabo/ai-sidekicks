// The browser pane holds no native host and calls no namespace it does not have.
//
// `Plan-023 §Console growth slate` row `browser-pane-namespace` still owes the whole
// `browser.*` IPC surface, and `Spec-023 §Console Design (Meridian)` 12.11 puts the
// native view behind a host seam that the console resolves to UNAVAILABLE until that
// wire lands. Both of those are promises about absence, and absence is the one
// property a reviewer cannot see: nothing in a diff looks like a method string that
// was invented, or like an `import { WebContentsView }` line that quietly gave a
// renderer module an opinion about a main-process class.
//
// So the claim is asserted mechanically, and it is TWO claims:
//
//   1. No source module names a `browser.<member>` string. Calling an unregistered
//      method is not a compile error anywhere — a bridge namespace reached by string
//      resolves at runtime — so the string itself is the observable signature.
//   2. No source module names `WebContentsView` in code. The pane's viewport is a
//      DOM element whose rectangle is PUBLISHED to a host; a renderer that imported
//      the view class would be reaching across the process boundary the seam exists
//      to keep, and a main-process module that constructed one would be the native
//      host this task deliberately did not mint.
//
// COMMENTS ARE NOT CODE, and the distinction is load-bearing rather than a
// convenience. `browser/geometry-publisher.ts` and `browser/keyboard-handback.ts` are
// REQUIRED to name `browser.setRect` and `browser.onAccelerator` in prose — naming the
// wire you do not have is how the next task finds what it owes — and `pane-kinds.ts`
// names `WebContentsView` when it says why a browser pane cannot be torn off into an
// auxiliary window. A checker that could not tell a sentence from a call site would
// force those explanations out of the tree, which is the opposite of what it is for.
// So the scanner strips comments first, tracking string and template state as it goes
// so that a `//` inside a URL is not read as the start of one.
//
// Test files are excluded: the controls below have to write the exact strings the
// rule forbids, and `console/browser/index.test.ts` names both unregistered wires
// on purpose, as its own negative control.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  readConsoleSourceModule,
  moduleNamed,
  CONSOLE_DIRECTORY,
  SHELL_DIRECTORY,
} from "../console-source-modules.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_SOURCE_ROOT = resolve(HERE, "..", "..", "..", "src");

/**
 * The four subtrees this claim is about, walked through the tier's ONE walk.
 *
 * Both process trees, because the second claim is about both of them: a renderer
 * module importing the view class reaches across the boundary, and a MAIN-process
 * module constructing one would be the native host this task deliberately did not
 * mint. The walk is not this file's to write — `source-walk-chokepoint.test.ts` fails
 * a gate that reaches renderer source through a `readdirSync` of its own — and it
 * takes its roots as a parameter for exactly this: a claim wider than the console
 * states the roots rather than growing a second opinion about what counts as source.
 */
const SOURCE_ROOTS: readonly string[] = [
  CONSOLE_DIRECTORY,
  SHELL_DIRECTORY,
  resolve(PACKAGE_SOURCE_ROOT, "main"),
  resolve(PACKAGE_SOURCE_ROOT, "preload"),
  resolve(PACKAGE_SOURCE_ROOT, "shared"),
];

const SOURCE_MODULES = consoleSourceModules({ roots: SOURCE_ROOTS });

/** A module that is expected to name the missing wire in prose, for the controls. */
const PROSE_WITNESS = "console/browser/geometry-publisher.ts";

/**
 * Specifier suffixes that make a `browser.` string a FILE rather than a namespace
 * member. `"./scenarios/browser.js"` is an import and not a call, and the carve-out
 * is written out so that widening it is a visible edit.
 */
const MODULE_SPECIFIER_SUFFIXES: readonly string[] = [
  ".js",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
];

/**
 * Replace every comment with spaces, preserving offsets and line breaks.
 *
 * A state machine rather than a regex because the two cheap regexes are both wrong in
 * a way that matters here: `//.*$` eats the second half of every `https://` URL, and
 * a non-greedy block-comment match walks straight through a string that happens to
 * contain a block-comment terminator.
 */
function stripComments(source: string): string {
  const output: string[] = [];
  let index = 0;
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "code") {
      if (character === "/" && next === "/") {
        state = "line";
        output.push("  ");
        index += 2;
        continue;
      }
      if (character === "/" && next === "*") {
        state = "block";
        output.push("  ");
        index += 2;
        continue;
      }
      state =
        character === "'"
          ? "single"
          : character === '"'
            ? "double"
            : character === "`"
              ? "template"
              : "code";
      output.push(character);
      index += 1;
      continue;
    }
    if (state === "line") {
      const isNewline = character === "\n";
      state = isNewline ? "code" : "line";
      output.push(isNewline ? "\n" : " ");
      index += 1;
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") {
        state = "code";
        output.push("  ");
        index += 2;
        continue;
      }
      output.push(character === "\n" ? "\n" : " ");
      index += 1;
      continue;
    }
    // Inside a string or template: copy verbatim, honouring the escape, and close on
    // the matching delimiter. Templates are opaque, which over-approximates by
    // keeping an interpolation's contents — the safe direction for a prohibition.
    if (character === "\\") {
      output.push(character, next);
      index += 2;
      continue;
    }
    const closes: boolean =
      (state === "single" && character === "'") ||
      (state === "double" && character === '"') ||
      (state === "template" && character === "`");
    state = closes ? "code" : state;
    output.push(character);
    index += 1;
  }
  return output.join("");
}

const BROWSER_NAMESPACE_PATTERN = /(["'`])browser(\.[A-Za-z][A-Za-z0-9_]*)+\1/gu;

/** Every forbidden signature in `source`, or `[]`. Pure, so the controls can drive it. */
function namespaceSignatures(source: string): readonly string[] {
  const code = stripComments(source);
  const strings = [...code.matchAll(BROWSER_NAMESPACE_PATTERN)]
    .map((match) => match[0])
    .filter(
      (literal) =>
        !MODULE_SPECIFIER_SUFFIXES.some((suffix) =>
          literal.endsWith(`${suffix}${literal[0] ?? ""}`),
        ),
    );
  return code.includes("WebContentsView") ? [...strings, "WebContentsView"] : strings;
}

function desktopSourceModules(): readonly string[] {
  return SOURCE_MODULES.map((module) => module.displayPath);
}

function readSource(module: string): string {
  return readConsoleSourceModule(moduleNamed(SOURCE_MODULES, module));
}

describe("browser pane — no namespace call and no native host", () => {
  const modules = desktopSourceModules();

  it("finds a source tree to scan at all", () => {
    // Without this, a wrong SOURCE_DIRECTORY would scan nothing and the clean result
    // below would be a claim about the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules).toContain(PROSE_WITNESS);
  });

  it("names no `browser.*` member and no `WebContentsView` in code", () => {
    const offenders = modules
      .map((module) => ({ module, signatures: namespaceSignatures(readSource(module)) }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${entry.module}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the checker bites on both forbidden shapes", () => {
    // The clean result above means nothing unless the needles match real code.
    expect(namespaceSignatures('const method = "browser.act";')).toStrictEqual(['"browser.act"']);
    expect(namespaceSignatures("await bridge.call(`browser.setRect`, rect);")).toStrictEqual([
      "`browser.setRect`",
    ]);
    expect(namespaceSignatures('import { WebContentsView } from "electron";')).toStrictEqual([
      "WebContentsView",
    ]);
  });

  it("negative control: prose naming the missing wire is not a call", () => {
    // The distinction the whole file turns on, driven against the predicate and then
    // against the real module that depends on it.
    expect(namespaceSignatures("// 12.3 names `browser.setRect` as the publish.")).toStrictEqual(
      [],
    );
    expect(
      namespaceSignatures("/* A `browser.act` arm would go here. */\nconst x = 1;"),
    ).toStrictEqual([]);
    const witness = readSource(PROSE_WITNESS);
    expect(witness).toContain("browser.setRect");
    expect(namespaceSignatures(witness)).toStrictEqual([]);
  });

  it("negative control: a module specifier and a URL are neither of them calls", () => {
    expect(namespaceSignatures('import { BROWSER_SCENARIO } from "./browser.js";')).toStrictEqual(
      [],
    );
    expect(namespaceSignatures('const home = "https://example.invalid/x";')).toStrictEqual([]);
    // A URL is also the case that defeats the cheap `//.*$` comment regex: stripping
    // it would delete the rest of this line and hide anything after it.
    expect(
      namespaceSignatures('const home = "https://example.invalid"; const m = "browser.act";'),
    ).toStrictEqual(['"browser.act"']);
  });
});
