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
// convenience. `browser/geometry/geometry-publisher.ts` and `browser/pane/handback/keyboard-handback.ts` are
// REQUIRED to name `browser.setRect` and `browser.onAccelerator` in prose — naming the
// wire you do not have is how the next task finds what it owes — and `pane-kinds.ts`
// names `WebContentsView` when it says why a browser pane cannot be torn off into an
// auxiliary window. A checker that could not tell a sentence from a call site would
// force those explanations out of the tree, which is the opposite of what it is for.
//
// THE INSTRUMENT IS THE PARSER, and this file is why the package has that rule. It
// carried a hand-written comment stripper — a six-state machine over characters,
// forty lines, with its own opinions about escapes, template interpolation, and where
// a line comment ends — written because the two cheap regexes were both wrong. The
// compiler already answers this: a comment is not a node, so it cannot be reported,
// and no state has to be tracked to know that. The stripper is deleted rather than
// kept as a second reader of the same text, and what replaces it also answers a
// question the stripper could not — a string literal is a `StringLiteral` node
// whether or not the quote that opened it is the one that closes it.
//
// Test files are excluded: the controls below have to write the exact strings the
// rule forbids, and `console/browser/index.test.ts` names both unregistered wires
// on purpose, as its own negative control.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
  consoleSourceModules,
  readModuleNamed,
  CONSOLE_DIRECTORY,
  SHELL_DIRECTORY,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * The budget this file states rather than inherits.
 *
 * Its claim is a parse pass over every console module, so what it costs is a
 * property of the TREE and grows with it. Measured on the authoring machine with a
 * warm transform cache and this file's neighbours for company, the pass is 2569 ms
 * — and on a cold cache, or under the aggregate gate's five-project concurrency, the
 * same pass crossed vitest's 5 s default with no change to the code it reads. That is
 * how it was found: two view families landed, the tree grew, and four whole-tree
 * gates that had never stated a budget began timing out on the load rather than on a
 * defect.
 *
 * Set well above the loaded measurement on purpose, and to the figure
 * `source-walk-chokepoint.test.ts` already states for the same reason: what a budget
 * guards is a pass that never settles, not a slow one, and a budget tightened to the
 * last measurement fails on the next machine rather than on the next defect.
 */
const CONSOLE_PARSE_ALLOWANCE_MS = 30_000;

vi.setConfig({ testTimeout: CONSOLE_PARSE_ALLOWANCE_MS });

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
const PROSE_WITNESS = "console/browser/geometry/geometry-publisher.ts";

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

/** The namespace whose members this console does not have. */
const UNREGISTERED_NAMESPACE = "browser";

/** The main-process class a renderer module must not name. */
const NATIVE_HOST_TYPE_NAME = "WebContentsView";

/** A whole string literal that is a `browser.<member>` path and nothing else. */
const BROWSER_NAMESPACE_PATTERN = /^browser(\.[A-Za-z][A-Za-z0-9_]*)+$/u;

/**
 * Every forbidden signature in `source`, or `[]`. Pure, so the controls can drive it.
 *
 * Two node shapes and no text scan. A namespace call is a STRING LITERAL whose whole
 * text is the path — anchored, so a sentence quoting one inside a longer literal is
 * not a call and neither is a URL — and the native host is an IDENTIFIER, which is
 * what an import, a type annotation, and a construction all are. Reported with the
 * quotes the module wrote, because that is what a person greps for after reading the
 * failure.
 */
function namespaceSignatures(fileName: string, source: string): readonly string[] {
  const parsed = parseSourceText(fileName, source);
  const found: string[] = [];
  forEachDescendant(parsed, (node) => {
    if (ts.isIdentifier(node) && node.text === NATIVE_HOST_TYPE_NAME) {
      found.push(NATIVE_HOST_TYPE_NAME);
      return;
    }
    if (!ts.isStringLiteralLike(node) || !BROWSER_NAMESPACE_PATTERN.test(node.text)) {
      return;
    }
    if (MODULE_SPECIFIER_SUFFIXES.some((suffix) => node.text.endsWith(suffix))) {
      return;
    }
    found.push(node.getText(parsed));
  });
  return [...new Set(found)];
}

function desktopSourceModules(): readonly string[] {
  return SOURCE_MODULES.map((module) => module.displayPath);
}

function readSource(module: string): string {
  return readModuleNamed(SOURCE_MODULES, module);
}

/** What the checker is asked, for one module of the scan. */
function signaturesOf(module: string): readonly string[] {
  return namespaceSignatures(module, readSource(module));
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
      .map((module) => ({ module, signatures: signaturesOf(module) }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${entry.module}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the checker bites on both forbidden shapes", () => {
    // The clean result above means nothing unless the node predicates match real code.
    expect(namespaceSignatures("caller.ts", 'const method = "browser.act";')).toStrictEqual([
      '"browser.act"',
    ]);
    expect(
      namespaceSignatures("caller.ts", "await bridge.call(`browser.setRect`, rect);"),
    ).toStrictEqual(["`browser.setRect`"]);
    expect(
      namespaceSignatures("caller.ts", 'import { WebContentsView } from "electron";'),
    ).toStrictEqual([NATIVE_HOST_TYPE_NAME]);
  });

  it("negative control: prose naming the missing wire is not a call", () => {
    // The distinction the whole file turns on, driven against the predicate and then
    // against the real module that depends on it.
    expect(
      namespaceSignatures("prose.ts", "// 12.3 names `browser.setRect` as the publish."),
    ).toStrictEqual([]);
    expect(
      namespaceSignatures("prose.ts", "/* A `browser.act` arm would go here. */\nconst x = 1;"),
    ).toStrictEqual([]);
    const witness = readSource(PROSE_WITNESS);
    expect(witness).toContain(`${UNREGISTERED_NAMESPACE}.setRect`);
    expect(signaturesOf(PROSE_WITNESS)).toStrictEqual([]);
  });

  it("negative control: a module specifier and a URL are neither of them calls", () => {
    expect(
      namespaceSignatures("importer.ts", 'import { BROWSER_SCENARIO } from "./browser.js";'),
    ).toStrictEqual([]);
    expect(
      namespaceSignatures("importer.ts", 'const home = "https://example.invalid/x";'),
    ).toStrictEqual([]);
    // A URL on the same line as a call is the case that defeated the cheap `//.*$`
    // comment regex the deleted stripper existed to avoid. The parse never had the
    // problem, and this pins that it still does not.
    expect(
      namespaceSignatures(
        "importer.ts",
        'const home = "https://example.invalid"; const m = "browser.act";',
      ),
    ).toStrictEqual(['"browser.act"']);
  });

  it("a sentence quoting a call inside a longer literal is not one", () => {
    // The anchoring, stated as a case rather than left to the regular expression's
    // quote-delimiter trick. A literal that CONTAINS the path is prose about the wire
    // — an error message, a slate row's description — and the whole-literal test is
    // what separates it from the call.
    expect(
      namespaceSignatures("slate.ts", 'const owed = "the browser.setRect wire is not registered";'),
    ).toStrictEqual([]);
    expect(namespaceSignatures("slate.ts", 'const method = "browser.setRect";')).toStrictEqual([
      '"browser.setRect"',
    ]);
  });

  it("negative control: a regex literal holding a quote defeated the stripper", () => {
    // The measured divergence, and the reason the stripper is gone rather than fixed.
    // Its character machine had no state for a regular expression, so the `"` inside
    // `/["']/u` opened a string it never closed and everything after it -- comments
    // included -- was copied through as code. The prose on the next line then matched,
    // and the gate FAILED a module that had done nothing wrong. Driving the old
    // predicate over this input returns ["`browser.setRect`"]; the parse returns
    // nothing, because a regular expression is a regular expression and a comment is
    // not a node.
    const sourceThatBrokeTheStripper = [
      "const quoted = /[\"']/u;",
      "// 12.3 names `browser.setRect` as the publish.",
      "",
    ].join("\n");
    expect(namespaceSignatures("pattern.ts", sourceThatBrokeTheStripper)).toStrictEqual([]);
    // And the same module with a real call in it is still reported, so the case above
    // is the stripper being wrong rather than the parse being blind.
    expect(
      namespaceSignatures("pattern.ts", `${sourceThatBrokeTheStripper}const m = "browser.act";`),
    ).toStrictEqual(['"browser.act"']);
  });
});
