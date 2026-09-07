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
  const withoutComments = cssText.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
  const preludes: string[] = [];
  let buffer = "";
  for (const character of withoutComments) {
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
