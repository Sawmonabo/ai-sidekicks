// Every `outline` shorthand in the console names an outline STYLE.
//
// WHY THIS IS A GATE AND NOT A LINT PREFERENCE. `outline` is a shorthand over
// `outline-width`, `outline-style`, and `outline-color`, and a shorthand resets every
// longhand it omits to that longhand's initial value. `outline-style` starts at `none`.
// So `outline: var(--meridian-focus-ring)` — a token that resolves to a COLOUR and
// nothing else — is a valid declaration that draws no outline at all: the colour lands
// on `outline-color`, the style is reset to `none`, and the rule renders as if it were
// not there.
//
// THE LIVE INSTANCE THAT PAID FOR THIS FILE. Three focus rules in the settings tree were
// written that way — the search destination's own heading among them, which is where
// `SettingsSurface` puts the ring after a keyboard-driven search. A person driving that
// search by keyboard landed on a heading whose `:focus` rule had already removed the
// browser's outline and whose `:focus-visible` rule drew nothing in its place, so the
// destination of the act had no focus indicator of any kind. Nothing reported it: the
// declaration parses, the token exists, and every screenshot reference is a picture of a
// tree with no focus in it.
//
// A BAN RATHER THAN A PIN. Unlike the cross-family collision census beside it, this has
// no resolution cost — the repair is `2px solid` in front of the token, which is what
// the other seventy-odd focus rules in the tree already say — so there is no debt to
// name and a single offence is a failure.

import { describe, expect, it } from "vitest";

import { consoleStylesheets, readConsoleSourceModule } from "../console-source-modules.js";
import { ruleDeclarations } from "./stylesheet-selectors.js";

/**
 * Every value that establishes an outline style on the shorthand.
 *
 * The nine drawn styles plus `none`, `hidden`, and `auto` from `outline-style`'s own
 * grammar, and the CSS-wide keywords, which set the whole shorthand rather than omitting
 * a longhand from it. A declaration naming one of these has decided what the outline
 * looks like; a declaration naming none of them has left it at `none` by accident.
 */
const OUTLINE_STYLE_KEYWORDS: ReadonlySet<string> = new Set([
  "auto",
  "dashed",
  "dotted",
  "double",
  "groove",
  "hidden",
  "inherit",
  "initial",
  "inset",
  "none",
  "outset",
  "revert",
  "revert-layer",
  "ridge",
  "solid",
  "unset",
]);

/**
 * The floor the scan has to clear to be believed.
 *
 * A reader that found no `outline` declaration at all would satisfy the ban perfectly,
 * which is the failure mode an empty-offence gate has and cannot see. Seventy-five
 * shorthand declarations were in the tree when this was written; the floor sits well
 * under that so ordinary authoring does not trip it and a broken scan does.
 */
const OUTLINE_DECLARATION_FLOOR = 50;

/** One offence, as a single comparable line: where it is and what it says. */
interface StylelessOutline {
  readonly displayPath: string;
  readonly value: string;
}

/**
 * The `outline` shorthand values in one sheet that name no style.
 *
 * Longhands are not the subject and are excluded by the property name: `outline-offset`
 * and `outline-color` set exactly what they name and reset nothing.
 */
function stylelessOutlinesIn(cssText: string): readonly string[] {
  return ruleDeclarations(cssText)
    .filter((declaration) => declaration.property === "outline")
    .filter((declaration) => !namesAnOutlineStyle(declaration.value))
    .map((declaration) => declaration.value);
}

/**
 * Whether a shorthand value establishes a style.
 *
 * Reads only the value's TOP-LEVEL words: everything inside a function is that
 * function's own argument list, so `var(--meridian-pane-hue, var(--meridian-focus-ring))`
 * contributes nothing and the `2px solid` in front of it is what decides. A custom
 * property could in principle resolve to `solid`, and this reader deliberately does not
 * believe that it does — a focus ring whose visibility depends on the contents of a
 * colour token is the defect rather than the exception.
 */
function namesAnOutlineStyle(value: string): boolean {
  return topLevelWords(value).some((word) => OUTLINE_STYLE_KEYWORDS.has(word));
}

/** The lowercased words of a declaration value, with every function's interior dropped. */
function topLevelWords(value: string): readonly string[] {
  const words: string[] = [];
  let buffer = "";
  let depth = 0;
  for (const character of value) {
    if (character === "(") {
      // The buffer holds the function's NAME, which is not a word of the value.
      depth += 1;
      buffer = "";
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      buffer = "";
      continue;
    }
    if (depth > 0) {
      continue;
    }
    if (/[\s,]/u.test(character)) {
      if (buffer !== "") {
        words.push(buffer.toLowerCase());
      }
      buffer = "";
      continue;
    }
    buffer += character;
  }
  if (buffer !== "") {
    words.push(buffer.toLowerCase());
  }
  return words;
}

/** Every offence in the tree, sorted by the path a failure names it at. */
function stylelessOutlines(): readonly StylelessOutline[] {
  const offences: StylelessOutline[] = [];
  for (const sheet of consoleStylesheets()) {
    for (const value of stylelessOutlinesIn(readConsoleSourceModule(sheet))) {
      offences.push({ displayPath: sheet.displayPath, value });
    }
  }
  return offences;
}

describe("the console's focus outlines", () => {
  it("names a style on every outline shorthand, so every ring is drawn", () => {
    expect(
      stylelessOutlines().map((offence) => `${offence.displayPath}: outline: ${offence.value}`),
    ).toStrictEqual([]);
  });

  // The positive control. Without it the ban above would pass over a scan that read no
  // declarations at all — an empty result proving nothing rather than a clean tree.
  it("reads the outline declarations the tree actually carries", () => {
    let outlineDeclarations = 0;
    let focusRingDeclarations = 0;
    for (const sheet of consoleStylesheets()) {
      for (const declaration of ruleDeclarations(readConsoleSourceModule(sheet))) {
        if (declaration.property !== "outline") {
          continue;
        }
        outlineDeclarations += 1;
        if (declaration.value.includes("--meridian-focus-ring")) {
          focusRingDeclarations += 1;
        }
      }
    }
    expect(outlineDeclarations).toBeGreaterThan(OUTLINE_DECLARATION_FLOOR);
    expect(focusRingDeclarations).toBeGreaterThan(OUTLINE_DECLARATION_FLOOR);
  });
});

describe("the styleless-outline reader, against planted stylesheets", () => {
  // The planted failure: the exact shape the three settings rules had.
  it("reports a shorthand given only a colour token", () => {
    expect(
      stylelessOutlinesIn(".planted:focus-visible { outline: var(--meridian-focus-ring); }"),
    ).toStrictEqual(["var(--meridian-focus-ring)"]);
  });

  it("reports a shorthand given only a width, which resets the style just as hard", () => {
    expect(stylelessOutlinesIn(".planted { outline: 2px; }")).toStrictEqual(["2px"]);
  });

  it("admits the form the rest of the tree uses, and the removal form beside it", () => {
    expect(
      stylelessOutlinesIn(
        ".a { outline: 2px solid var(--meridian-focus-ring); }\n.b { outline: none; }",
      ),
    ).toStrictEqual([]);
  });

  it("admits a style in front of a nested fallback rather than reading the fallback", () => {
    expect(
      stylelessOutlinesIn(
        ".a { outline: 2px solid var(--meridian-pane-hue, var(--meridian-focus-ring)); }",
      ),
    ).toStrictEqual([]);
  });

  // The longhands set exactly what they name, so they are not the subject — and a reader
  // that matched on a prefix would report every `outline-offset` in the tree.
  it("reads no offence out of the longhand properties", () => {
    expect(
      stylelessOutlinesIn(
        ".a { outline-offset: var(--meridian-space-1); outline-color: var(--meridian-focus-ring); }",
      ),
    ).toStrictEqual([]);
  });

  // A rule nested inside a media query is reached, so an offence cannot hide in one.
  it("reaches a declaration nested inside an at-rule", () => {
    expect(
      stylelessOutlinesIn(
        "@media (min-width: 40rem) { .a:focus-visible { outline: var(--meridian-focus-ring); } }",
      ),
    ).toStrictEqual(["var(--meridian-focus-ring)"]);
  });

  // And the at-rule's own prelude is not a declaration, though it carries a colon.
  it("mints no declaration from an at-rule prelude or a top-level statement", () => {
    expect(
      ruleDeclarations("@import url(x.css);\n@media (min-width: 40rem) { .a { top: 0; } }").map(
        (declaration) => declaration.property,
      ),
    ).toStrictEqual(["top"]);
  });

  it("mints no declaration from a comment, whatever the comment contains", () => {
    expect(
      ruleDeclarations("/* outline: var(--meridian-focus-ring); */\n.a { top: 0; }").map(
        (declaration) => declaration.property,
      ),
    ).toStrictEqual(["top"]);
  });
});
