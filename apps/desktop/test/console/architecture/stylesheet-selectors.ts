// The one reading of CSS the architecture tier does: what a stylesheet DECLARES.
//
// TWO GATES ASK THIS QUESTION AND THERE IS ONE ANSWER HERE. The cross-family collision
// census (`stylesheet-selector-owners.ts`) asks which classes a sheet declares so it can
// find two families declaring one; the chunk-root placement census
// (`stylesheet-static-reach.ts`) asks the same thing so it can tell whether any module on
// a door's static graph could render against the sheet. Both were carrying their own
// copy of the same comment strip, the same brace scan, and the same class-token pattern.
//
// WHY THAT IS A DEFECT AND NOT A DUPLICATION NUISANCE. `apps/desktop/AGENTS.md` states
// it as a rule — two sides of one seam share a module, never two copies of one regular
// expression or normalization, because they drift and the gate goes green. Here the
// drift is silent in the direction that matters: the placement gate reports an offence
// when it finds NO user of a sheet's classes, so a grammar correction landing in one copy
// and not the other makes one census read a sheet the other cannot, and the disagreement
// surfaces as a green run rather than as a conflict.
//
// THE GRAMMAR IS DELIBERATELY SMALL. It answers one question — which class names appear
// in a rule's PRELUDE — and it is written to be wrong in one direction only: it
// over-reports (a class named inside a `:is()` or an attribute selector counts) and never
// under-reports, because both callers use the answer to REFUSE a move rather than to
// admit one.

/**
 * The selector preludes in a stylesheet: the text before each rule's opening brace.
 *
 * A BRACE SCAN RATHER THAN ONE PATTERN OVER THE FILE, and the difference is not pedantry.
 * A declaration value carries dotted text — `content: ".";`, `transition: transform .2s`
 * — and a pattern that reads the file as one string reports those as class names, which
 * makes a collision census that fires on punctuation. The scan resets its buffer at `}`
 * and at `;`, so only text that actually preceded a `{` is ever read as a selector.
 *
 * COMMENTS ARE STRIPPED FIRST, which is what keeps a `{` inside one from opening a rule
 * that never existed and swallowing the selector that follows it: `/* a { b *\/ .c { }`
 * declares `.c` and nothing else.
 *
 * At-rule preludes are dropped by their leading `@`: `@media (min-width: 40rem)` names no
 * class, and the rules nested inside it are reached by the same scan one level down.
 */
export function selectorPreludes(cssText: string): readonly string[] {
  const preludes: string[] = [];
  let buffer = "";
  for (const character of withoutComments(cssText)) {
    if (character === "{" || character === "}" || character === ";") {
      const prelude = buffer.trim();
      if (character === "{" && prelude !== "" && !prelude.startsWith("@")) {
        preludes.push(prelude);
      }
      buffer = "";
      continue;
    }
    buffer += character;
  }
  return preludes;
}

/**
 * Every class name a stylesheet DECLARES, deduplicated.
 *
 * Reads the class token out of selector preludes only, so a sheet that mentions another
 * family's class in a comment or inside a declaration value declares nothing. The token
 * pattern requires a letter, `_`, or `-` after the dot, which is what keeps `.5s` in a
 * prelude-adjacent position from reading as a class.
 */
export function declaredClassNames(cssText: string): ReadonlySet<string> {
  const classNames = new Set<string>();
  for (const prelude of selectorPreludes(cssText)) {
    for (const match of prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)) {
      const className = match[1];
      if (className !== undefined) {
        classNames.add(className);
      }
    }
  }
  return classNames;
}

/** One declaration inside a rule body: the property, and the value it was given. */
export interface StylesheetDeclaration {
  /** Lowercased, so a property is one string however it was typed. */
  readonly property: string;
  /** Trimmed, otherwise verbatim — functions, custom properties, and all. */
  readonly value: string;
}

/**
 * Every declaration a stylesheet makes, in source order.
 *
 * THE OTHER HALF OF THE SAME SCAN, and it is here rather than beside its one gate for
 * this module's own stated reason: the comment strip and the brace walk are the part
 * two readings of a stylesheet share, and a second copy of either drifts silently.
 * {@link selectorPreludes} reads what precedes a `{`; this reads what follows one.
 *
 * DEPTH IS WHAT SEPARATES A DECLARATION FROM A PRELUDE. Text terminated by `;` or `}`
 * at depth zero is not inside any rule — `@import url(x.css);` is the live shape — and
 * an at-rule's own prelude never reaches a terminator at all, because the buffer resets
 * at the `{` that opens it. So `@media (min-width: 40rem)` yields no `min-width`
 * declaration even though it carries a colon.
 *
 * Over-reporting is impossible in the direction that matters and under-reporting is the
 * only risk, so the reader refuses anything whose property is not a plain identifier: a
 * caller uses this to REFUSE a declaration, and a malformed split would refuse text
 * nobody wrote.
 */
export function ruleDeclarations(cssText: string): readonly StylesheetDeclaration[] {
  const declarations: StylesheetDeclaration[] = [];
  let buffer = "";
  let depth = 0;
  for (const character of withoutComments(cssText)) {
    if (character === "{") {
      depth += 1;
      buffer = "";
      continue;
    }
    if (character === "}" || character === ";") {
      const declaration = depth === 0 ? undefined : readDeclaration(buffer);
      if (declaration !== undefined) {
        declarations.push(declaration);
      }
      if (character === "}") {
        depth = Math.max(0, depth - 1);
      }
      buffer = "";
      continue;
    }
    buffer += character;
  }
  return declarations;
}

/** A stylesheet with its comments removed, which is where both scans start. */
function withoutComments(cssText: string): string {
  return cssText.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
}

/** One buffered `property: value`, or nothing where the text is not one. */
function readDeclaration(buffer: string): StylesheetDeclaration | undefined {
  const separator = buffer.indexOf(":");
  if (separator === -1) {
    return undefined;
  }
  const property = buffer.slice(0, separator).trim();
  if (!/^-{0,2}[a-zA-Z][\w-]*$/u.test(property)) {
    return undefined;
  }
  return { property: property.toLowerCase(), value: buffer.slice(separator + 1).trim() };
}
