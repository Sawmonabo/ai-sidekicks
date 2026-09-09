// The reading the path-claim gate next door runs: which backticked path names nothing.
//
// A MODEL BESIDE ITS GATE, on the `stranded-documentation.ts` and `barrel-census.ts`
// pattern. Every predicate takes text as a parameter, so the gate's controls drive the
// real reading over planted corpora; the walk that produces the real file set stays in
// the gate, where `source-walk-chokepoint.test.ts` can see it.
//
// WHY THERE IS A GATE AT ALL. Three module-move PRs in a row each left a wave of header
// comments naming a module at its old path — 122 sites in 98 files after one of them,
// every one of them a sentence that reads correctly and points at nothing. No gate in
// this package reads those tokens: the compiler resolves SPECIFIERS and never prose,
// `knip` resolves imports, `dependency-cruiser` resolves edges, and a backtick in a
// comment is invisible to all three. The claim here is the missing one — a backticked
// token shaped like a repository path resolves to something on disk.
//
// THE SHAPE IS THE WHOLE OF THE PRECISION, because the gate has no way to ask what a
// sentence meant. A token qualifies only if it carries a `/` and ends in an extension
// this package's trees actually write, with no whitespace anywhere in it. That is
// deliberately narrower than "looks like a path": `budgets.json` and `main.tsx` carry
// no separator and are names rather than locations, and a prose fragment with a space
// in it is a sentence someone wrapped in backticks. Both classes are outside the claim
// rather than admitted and then excused, which is what keeps the exclusion list from
// growing into an allowlist.
//
// `.js` IS ABSENT FROM THAT SET AND ITS ABSENCE IS LOAD-BEARING. This package writes
// ESM specifiers as `./thing.js` against a `thing.ts` on disk, so every relative import
// in every comment that quotes one would resolve to nothing and the gate would report
// the whole tree. The extension set is what a file is NAMED, never what a specifier
// says — which is also why the token `bridge/fixture/call-plane/bridge.test-support.ts`
// is inside the claim and `../typescript-source.js` beside it is not.
//
// RESOLUTION IS CASE-EXACT, and that is not fussiness. The authoring machines run a
// case-insensitive volume and CI does not, so a claim that spells a real directory or
// a real file with the wrong case resolves here and fails there — a gate that reports
// green locally and red on the runner is worse than no gate, because it teaches a
// reader to distrust the run. Every segment is checked against the directory's own
// entries, and the gate next door drives that with a foil built out of two names this
// tree really has.

import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import ts from "typescript";

import { TYPESCRIPT_MODULE_EXTENSIONS } from "../console-source-classification.js";
import { commentRangesIn, forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * What a backticked token has to end in to be read as a path.
 *
 * The TypeScript half comes from the classification module rather than being written
 * again, so a fifth module extension is admitted here the day that set grows — the
 * failure of a second copy is silent by construction, since a token this set refuses
 * is simply absent from the claim. The four beside it are the non-TypeScript files this
 * package's prose names: stylesheets, the budget and tool JSON, the flat-config `.mjs`
 * at the package root, and the governing documents under `docs/`.
 */
export const PATH_CLAIM_EXTENSIONS: readonly string[] = [
  ...TYPESCRIPT_MODULE_EXTENSIONS,
  ".css",
  ".json",
  ".mjs",
  ".md",
];

/** One file this gate reads, and where a relative claim inside it resolves from. */
export interface PathClaimSubject {
  /** What a failure message names the file by. */
  readonly displayPath: string;
  readonly source: string;
  /** The absolute directory the file sits in — the first resolution base. */
  readonly ownDirectory: string;
}

/** One backticked path token, where it was written, and what it names. */
export interface PathClaim {
  readonly displayPath: string;
  readonly line: number;
  /** The backtick contents verbatim, any `:NNN` or `#anchor` locator included. */
  readonly token: string;
  /** The token with its locator removed — what resolution is attempted against. */
  readonly path: string;
}

/** A stretch of raw source text a claim may be written in, and where it starts. */
export interface SourceTextSpan {
  readonly start: number;
  readonly text: string;
}

/**
 * A backtick-delimited run carrying no backtick, no newline, and no whitespace.
 *
 * Whitespace is refused inside the pattern rather than tested after it so a sentence
 * wrapped in backticks cannot swallow the path beside it: `` `see foo/bar.ts` `` would
 * otherwise capture one token ending in a real extension and report the sentence.
 */
const BACKTICKED_TOKEN = /`([^`\s]+)`/g;

/** The `:NNN` line cite and the `#anchor` fragment a claim may carry after the path. */
const CLAIM_LOCATOR = /(?::\d+|#[^`]*)$/;

/**
 * What makes a token a shape rather than a location.
 *
 * A glob star, and the two metavariable spellings this package writes: `<family>` for a
 * name the sentence stands in for, and an ellipsis for a path it elides. All three name
 * a SET of files, so asking whether one exists is the wrong question — and every one of
 * them is a form a reader recognises on sight, which is why they are a class and not
 * three entries on a list.
 */
const PATTERN_MARKERS: readonly string[] = ["*", "<", ">", "\u2026"];

/** The segment that makes a path someone else's tree. */
const DEPENDENCY_SEGMENT = "node_modules";

/** What a package specifier starts with, which is a module name and not a location. */
const PACKAGE_SCOPE_PREFIX = "@";

/**
 * The token kinds whose raw text a claim can be written inside.
 *
 * The template parts are here for the same reason the string literal is: a gate's
 * failure message is routinely composed as a template, and the path it names is inside
 * one. Read as three kinds rather than through `isStringLiteralLike`, which covers the
 * substitution-free template and not the head, middle, or tail of one that has spans.
 */
const TEXT_TOKEN_KINDS: readonly ts.SyntaxKind[] = [
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
];

/** The extension whose file carries no code, so every backtick in it is prose. */
const DATA_DOCUMENT_EXTENSION = ".json";

/**
 * Every stretch of `source` a path claim may be written in.
 *
 * TWO ARMS AND ONE HOME, because the two file kinds this gate reads answer the same
 * question with different instruments. A TypeScript module needs the parse: a backtick
 * inside a regular expression or a JSX attribute is not prose, and only the compiler
 * knows which is which. A JSON document has no code at all — no comments, no
 * expressions, nothing but string values — so its whole text is one span, and parsing
 * it to rebuild that fact would be a second reader answering what the file's own
 * grammar already guarantees.
 *
 * A SPAN CARRIES ITS ABSOLUTE OFFSET rather than its line, so a token found in the
 * middle of a forty-line header reports the line it was written on instead of the line
 * the block opened on. That is the whole reason the reading is spans and not strings.
 */
export function pathClaimSpansIn(fileName: string, source: string): readonly SourceTextSpan[] {
  if (fileName.endsWith(DATA_DOCUMENT_EXTENSION)) {
    return [{ start: 0, text: source }];
  }
  const sourceFile = parseSourceText(fileName, source);
  const spans: SourceTextSpan[] = commentRangesIn(sourceFile, source).map((range) => ({
    start: range.pos,
    text: source.slice(range.pos, range.end),
  }));
  forEachDescendant(sourceFile, (node) => {
    if (!TEXT_TOKEN_KINDS.includes(node.kind)) {
      return;
    }
    const start = node.getStart(sourceFile);
    spans.push({ start, text: source.slice(start, node.end) });
  });
  return spans.sort((left, right) => left.start - right.start);
}

/** Whether `token`, locator already removed, is shaped like a path into this repository. */
function isPathShaped(path: string): boolean {
  if (!path.includes("/") || PATTERN_MARKERS.some((marker) => path.includes(marker))) {
    return false;
  }
  // A LEADING SEPARATOR IS A SUFFIX CLAIM, not an absolute path. Nothing in this
  // package writes a path from the filesystem root, and what a leading `/` does mean
  // here is "ends with" — a barrel matched by its `/index.ts` tail, a chunk root by its
  // directory prefix. Resolving one would ask whether the machine has a top-level
  // directory named after a console family.
  if (path.startsWith("/")) {
    return false;
  }
  if (path.startsWith(PACKAGE_SCOPE_PREFIX) || path.split("/").includes(DEPENDENCY_SEGMENT)) {
    return false;
  }
  return PATH_CLAIM_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/**
 * Every path claim in one file, in source order.
 *
 * `excluded` is the foil set — the strings sibling suites plant on purpose so their own
 * negative controls have something to fail on. It is subtracted by exact string rather
 * than by file, so admitting a foil admits that one token and never the module holding
 * it; the gate reads the set out of the tree's own `*_FOILS` exports rather than
 * carrying a list.
 */
export function pathClaimsIn(
  subject: PathClaimSubject,
  excluded: ReadonlySet<string> = new Set(),
): readonly PathClaim[] {
  const lineStarts = lineStartsOf(subject.source);
  const claims: PathClaim[] = [];
  for (const span of pathClaimSpansIn(subject.displayPath, subject.source)) {
    for (const match of span.text.matchAll(BACKTICKED_TOKEN)) {
      const token = match[1] ?? "";
      const path = token.replace(CLAIM_LOCATOR, "");
      if (!isPathShaped(path) || excluded.has(token) || excluded.has(path)) {
        continue;
      }
      claims.push({
        displayPath: subject.displayPath,
        line: lineOf(lineStarts, span.start + (match.index ?? 0)),
        token,
        path,
      });
    }
  }
  return claims;
}

/**
 * The bases a claim is tried against, and whether one of them holds it.
 *
 * EVERY ANCESTOR OF THE CLAIMING FILE, and that is a measurement rather than a
 * generosity. A fixed list of six roots — the file's directory, the console, the
 * renderer, `src/`, `test/`, the package, the repository — was written first and
 * reported 358 sites on a clean tree, almost all of them correct: this package writes a
 * prose path relative to whatever directory makes the sentence read, and the commonest
 * spelling by far strips a root the reader already has in mind:
 * `bridge/approvals/index.ts` names `bridge/growth-signatures/approvals.ts` with the
 * family gone, and `scripts/budget/budget-document.mts` names
 * `test/console/architecture/launch-deadline.test.ts` with the tier gone. Neither
 * shortened form is reachable from any of those six, and a gate that reported both
 * would be asking for three hundred correct comments to be rewritten in its dialect.
 *
 * AND IT COSTS THE CLAIM NOTHING, which is why the widening is admissible: the defect
 * is a module that MOVED, and a path naming a directory the tree no longer has resolves
 * under no ancestor of any file. What the ancestors admit is exactly what a reader
 * admits — a relative claim read from somewhere on the claiming file's own path.
 *
 * THE EXTRA BASES ARE THE ROOTS A FILE CANNOT REACH BY CLIMBING. A suite under `test/`
 * names a console module `seats/pane-chrome.css` with no prefix, and a module under
 * `src/` names the suite that holds it to a rule as `architecture/barrel-census.test.ts`
 * — neither tree is under the other, so those roots are supplied whatever the claiming
 * file's ancestry is.
 *
 * AND EVERY ANCESTOR'S `node_modules` IS A BASE, because a comment explaining why a
 * dependency behaves as it does names the module inside it that decides — the `zod`
 * subpath a validator is compiled from, the addon file a terminal renderer loads. Those
 * paths are real and openable; what they are not is first-party, and resolving them is
 * both cheaper and truer than a rule that guessed at which first segments are package
 * names.
 *
 * A CLASS RATHER THAN A FUNCTION because the answer is memoised: resolution reads
 * directories to check the CASE of every segment, and the same handful of directories
 * answers for hundreds of claims. The cache is per instance, so a control drives a
 * resolver over a planted tree without the real one's readings in it.
 */
export class PathClaimResolver {
  readonly #ceiling: string;
  readonly #extraBases: readonly string[];
  readonly #entriesByDirectory = new Map<string, ReadonlySet<string>>();

  /**
   * @param ceiling The highest ancestor a claim may be read from — the repository.
   * @param extraBases Bases supplied whatever the claiming file's ancestry is.
   */
  public constructor(ceiling: string, extraBases: readonly string[]) {
    this.#ceiling = ceiling;
    this.#extraBases = extraBases;
  }

  /** Whether `claim` names a file reachable from any ancestor of `ownDirectory`. */
  public resolves(claim: PathClaim, ownDirectory: string): boolean {
    const ancestors = this.#ancestorsOf(ownDirectory);
    const bases = [
      ...ancestors,
      ...ancestors.map((ancestor) => join(ancestor, DEPENDENCY_SEGMENT)),
      ...this.#extraBases,
    ];
    return bases.some((base) => this.#existsCaseExact(resolve(base, claim.path)));
  }

  /**
   * `ownDirectory` and every directory above it up to the ceiling, nearest first.
   *
   * Stops AT the ceiling rather than at the filesystem root, so a claim is never read
   * from the directory the repository was cloned into — where a sibling checkout of an
   * unrelated tree could resolve a path this one does not have.
   */
  #ancestorsOf(ownDirectory: string): readonly string[] {
    const ancestors: string[] = [];
    for (
      let directory = resolve(ownDirectory);
      directory.startsWith(this.#ceiling);
      directory = dirname(directory)
    ) {
      ancestors.push(directory);
      if (directory === this.#ceiling) {
        break;
      }
    }
    return ancestors;
  }

  /**
   * Whether `absolutePath` exists with the casing it is spelled with.
   *
   * `existsSync` alone is the wrong instrument on the authoring platform and the right
   * one everywhere else, which is the worst combination a gate can have. Each segment
   * is therefore checked against its parent's own entries — and the cheap answer is
   * asked first, so a path that does not exist at all costs one `stat` rather than a
   * walk of its ancestry.
   */
  #existsCaseExact(absolutePath: string): boolean {
    if (!existsSync(absolutePath)) {
      return false;
    }
    const { root, dir, base } = parse(absolutePath);
    if (!isAbsolute(absolutePath) || dir === absolutePath) {
      return true;
    }
    return this.#entriesOf(dir).has(base) && (dir === root || this.#existsCaseExact(dir));
  }

  /** One directory's entry names, read once. */
  #entriesOf(directory: string): ReadonlySet<string> {
    const cached = this.#entriesByDirectory.get(directory);
    if (cached !== undefined) {
      return cached;
    }
    const entries = new Set(existsSync(directory) ? readdirSync(directory) : []);
    this.#entriesByDirectory.set(directory, entries);
    return entries;
  }
}

/** Every claim in `subjects` that no base holds, in scan order. */
export function unresolvedPathClaims(
  subjects: readonly PathClaimSubject[],
  resolver: PathClaimResolver,
  excluded: ReadonlySet<string> = new Set(),
): readonly PathClaim[] {
  return subjects.flatMap((subject) =>
    pathClaimsIn(subject, excluded).filter(
      (claim) => !resolver.resolves(claim, subject.ownDirectory),
    ),
  );
}

/** How a failure names one: where it was written, and what it claimed. */
export function describePathClaim(claim: PathClaim): string {
  return `${claim.displayPath}:${String(claim.line)} → ${claim.token}`;
}

/**
 * Every string a `*_FOILS` export in `source` holds, at any depth.
 *
 * THE EXCLUSION CLASS THIS GATE HAS, and it is read out of the tree rather than listed.
 * A sibling suite whose whole subject is a rule biting has to write the thing the rule
 * forbids, and for an import-shape ban that means a specifier naming a module that must
 * not exist. `apps/desktop/AGENTS.md` §Tests requires every clean result to have a
 * negative control, so those strings are not an accident to be tolerated — they are the
 * evidence the sibling gate works, and a path gate that reported them would be
 * demanding that the tier's controls be deleted.
 *
 * KEYED ON THE EXPORT NAME, which is the naming convention the tier already uses and
 * the narrowest thing that could carry the claim: a foil declared under any other name
 * is reported, so the exemption cannot be taken by writing a stale claim into a
 * differently-named constant. Every string LITERAL under the initializer is collected,
 * at any nesting depth, because a foil table is routinely a list of objects.
 */
export function foilStringsIn(fileName: string, source: string): readonly string[] {
  const found: string[] = [];
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.name.text.endsWith("_FOILS") ||
      node.initializer === undefined
    ) {
      return;
    }
    forEachDescendant(node.initializer, (descendant) => {
      if (ts.isStringLiteralLike(descendant)) {
        found.push(descendant.text);
      }
    });
  });
  return found;
}

/** Where each line of `source` begins, so an offset can be named by line. */
function lineStartsOf(source: string): readonly number[] {
  const starts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

/** The one-based line `offset` falls on. */
function lineOf(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low + 1;
}
