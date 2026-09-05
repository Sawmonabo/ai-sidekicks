// Which names a module HOLDS, read from its source text.
//
// The budget registry's `measuredBy` used to be checked with `existsSync` and
// nothing else, and a path that exists says nothing about what the file does:
// two rows named `architecture/launch-deadline.test.ts` for bounds that file
// never drives — it compares registry figures with imported constants, while the
// suites that hold `FrameWitness` and `BoundedCleanup` are their own files. So a
// row now names the symbol its harness must hold, and this module answers whether
// the harness holds it.
//
// WHY SOURCE TEXT AND NOT A PARSER
//
// The question is deliberately narrow: is this identifier a binding this file
// declares or imports? TypeScript's own parser would answer it, and pulling the
// compiler into a budget gate to ask one question about six files is a large
// dependency for a small claim. The patterns below are anchored at the start of a
// line instead, which is what keeps a comment out of the answer: a commented-out
// import begins with `//` or `*`, so it never reaches them. That property is a
// case in `module-bindings.test.ts` rather than an assertion here.

/** Words that appear inside an import clause and bind nothing. */
const IMPORT_CLAUSE_KEYWORDS: ReadonlySet<string> = new Set(["type", "as"]);

/**
 * An import declaration's clause — everything between `import` and `from`.
 *
 * Lazy across newlines because a clause is routinely a multi-line brace list, and
 * anchored at the line start so a `//` or ` *` comment line cannot open one.
 */
const IMPORT_CLAUSE_PATTERN = /^[\t ]*import\b([\s\S]*?)\bfrom\b/gm;

/**
 * A declaration's own name.
 *
 * Anchored for the same reason, and deliberately not limited to top level: a
 * name declared anywhere in the file is a name the file holds, which is the
 * question being asked.
 */
const DECLARATION_PATTERN =
  /^[\t ]*(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

const IDENTIFIER_PATTERN = /[A-Za-z_$][\w$]*/gu;

/**
 * Every name `sourceText` declares or imports.
 *
 * Both halves are needed by real rows: a test harness IMPORTS the class it
 * drives, while a measuring script DECLARES the measurer it runs — and a rule
 * that admitted only one of those would refuse a row that is perfectly honest.
 */
export function bindingsHeldBy(sourceText: string): ReadonlySet<string> {
  const bindings = new Set<string>();
  for (const clauseMatch of sourceText.matchAll(IMPORT_CLAUSE_PATTERN)) {
    for (const identifier of clauseMatch[1]?.match(IDENTIFIER_PATTERN) ?? []) {
      if (!IMPORT_CLAUSE_KEYWORDS.has(identifier)) {
        bindings.add(identifier);
      }
    }
  }
  for (const declarationMatch of sourceText.matchAll(DECLARATION_PATTERN)) {
    const declaredName = declarationMatch[1];
    if (declaredName !== undefined) {
      bindings.add(declaredName);
    }
  }
  return bindings;
}
