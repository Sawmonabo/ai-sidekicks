// The byte-MEASUREMENT chokepoint, asserted.
//
// `apps/desktop/AGENTS.md` §Chokepoints says "one byte-measurement function serves
// every cap". That rule had no mechanism, and the console shipped two: the durable
// path's `console/persistence/value-classes.ts` and a second declaration inside
// `ledger/cards/markdown/byte-bounded-cache.ts`, re-published through the markdown
// sub-module's own door. Both answered the same question and each carried a comment
// justifying itself against the other — which is what a drift looks like before the
// two answers separate.
//
// WHY THE SECOND ONE IS A HAZARD AND NOT A DUPLICATE LINE. A cap is a refusal: a
// sentence over the bound is not stored, not sent, or not cached. Two rulers mean two
// refusal boundaries over one sentence, and they agree on ASCII — which is the whole
// problem, because agreement on ASCII is what makes the disagreement invisible until
// the first body carrying a surrogate pair, a combining mark, or a normalisation the
// one ruler grew and the other did not. Nothing reports it: both files compile, both
// tests pass, and the two caps simply admit different text.
//
// THIS IS THE MEASUREMENT CLAIM, AND `wire-figure-chokepoint.test.ts` IS THE SCALING
// ONE. They are deliberately two gates over two acts. Scaling converts a byte count
// into a figure a person reads and names a unit doing it; measuring converts text into
// a byte count nothing renders. That file's own header draws the same line from the
// other side — a module that merely bounds a byte count is not scaling — so extending
// it here would have put a claim about a value that never reaches the screen inside a
// gate whose subject is what does.
//
// THE SIGNATURE IS `TextEncoder`, WHICH IS THE ACT ITSELF. A UTF-8 byte length cannot
// be obtained in the renderer any other way: `String.length` counts UTF-16 code units
// and is the mistake this chokepoint exists to keep to one place, and every other
// route — `Blob`, `Buffer` — is either unavailable or a node built-in the renderer
// does not carry. So a module that reaches the name has measured, whatever it named
// the function it did the measuring in, and a rule keyed on the function's NAME would
// be a rule the next copy evades by calling itself something else.
//
// AND THE REACH IS READ OUT OF THE PARSE. A text scan for `TextEncoder` cannot tell a
// declaration from the word inside this header, and a chokepoint whose reader counts
// its own prose is a gate that fails the day somebody documents it.
//
// Test files are excluded: a suite asserting what a measurement returns may construct
// its own encoder to state the expected byte count independently, and forbidding that
// would forbid checking the chokepoint against anything but itself.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * The one module allowed to measure a string in bytes.
 *
 * An allow-list of exactly one, written as a path rather than inferred from a naming
 * convention, so moving the chokepoint is an edit a reviewer sees.
 */
const CHOKEPOINT_MODULE = "console/persistence/value-classes.ts";

/** The global whose construction IS the measurement. */
const ENCODER_GLOBAL = "TextEncoder";

/**
 * Whether one module's source reaches the encoder, answered by the parser.
 *
 * Every identifier in the tree is asked, so `new TextEncoder()`, a `TextEncoder`-typed
 * field, and a `globalThis.TextEncoder` property read are one answer rather than three
 * spellings a needle list would have to carry — and a mention inside a comment or a
 * string is none of them, because neither is an identifier.
 */
export function reachesEncoder(fileName: string, sourceText: string): boolean {
  let reached = false;
  forEachDescendant(parseSourceText(fileName, sourceText), (descendant) => {
    if (ts.isIdentifier(descendant) && descendant.text === ENCODER_GLOBAL) {
      reached = true;
    }
  });
  return reached;
}

describe("utf8-measurement — one module measures a string in bytes", () => {
  const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

  it("scans the console at all", () => {
    // Without this a renamed root would scan nothing and the claim below would pass
    // over the empty set, which is exactly how a chokepoint goes quiet.
    expect(modules.length).toBeGreaterThan(200);
    expect(modules.map((module) => module.displayPath)).toContain(CHOKEPOINT_MODULE);
  });

  it("reaches the encoder from the chokepoint and from nowhere else", () => {
    const reaching = modules
      .filter((module) => reachesEncoder(module.displayPath, readConsoleSourceModule(module)))
      .map((module) => module.displayPath);
    expect(reaching).toStrictEqual([CHOKEPOINT_MODULE]);
  });

  it("negative control: the chokepoint itself trips the signature", () => {
    // The reader runs over real files. Without this, a signature that matched nothing
    // at all would satisfy the claim above perfectly.
    const chokepoint = moduleNamed(modules, CHOKEPOINT_MODULE, "the byte-measurement chokepoint");
    expect(reachesEncoder(chokepoint.displayPath, readConsoleSourceModule(chokepoint))).toBe(true);
  });

  it("negative control: the second declaration this rule was written against trips it", () => {
    // Planted verbatim from the copy that shipped inside the markdown cache, so the
    // gate is proven against the shape it exists to refuse rather than against a
    // shape invented for the test.
    expect(
      reachesEncoder(
        "planted.ts",
        "export function measureUtf8ByteLength(value: string): number {\n" +
          "  return new TextEncoder().encode(value).byteLength;\n" +
          "}\n",
      ),
    ).toBe(true);
    // And the module-scope form the durable path holds, which is the same reach.
    expect(reachesEncoder("planted.ts", "const UTF8_ENCODER = new TextEncoder();")).toBe(true);
  });

  it("negative control: counting code units is not measuring bytes, and prose is not a reach", () => {
    // The two sides of the line the header draws. A module that takes a string length
    // has not measured bytes — it has made the mistake — and a module that documents
    // the chokepoint has not reached it.
    expect(reachesEncoder("planted.ts", "const codeUnits = value.length;")).toBe(false);
    expect(reachesEncoder("planted.ts", "// A TextEncoder lives in the persistence door.")).toBe(
      false,
    );
    expect(reachesEncoder("planted.ts", 'const named = "TextEncoder";')).toBe(false);
  });
});
