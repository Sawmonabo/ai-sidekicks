// Every public method the session-store registry publishes has a production reader.
//
// THE CLASS OF DEFECT NO EXISTING GATE REPORTS. `knip` answers reachability at the
// level of FILES, EXPORTS, TYPES, and DEPENDENCIES — a class that is imported and
// constructed is reached, and every method hanging off it is reached with it. It does
// not report an unused class METHOD, and `dependency-cruiser` answers a question about
// import edges rather than about members. The barrel census is the console's own
// remedy for a door line with no reader, and it is likewise blind here: the registry's
// door line is read, so the barrel is honest while a method behind it is not.
//
// So the gap was measured rather than assumed. `SessionStoreRegistry.timelineResumeFor`
// shipped with zero callers anywhere outside its own declaration: the resume decision
// was computed on every read, kept on the entry, forwarded by the registry, and
// rendered by nothing. Every gate was green, and a fact the console computed on every
// read of every session reached no screen. THE GATE NEEDED WIDENING — this file is
// that widening, and it is the console-wide claim rather than a second assertion inside
// the store family's own suite, because a family asserting its own reachability is
// asserting it about the file it is written in.
//
// WHY THE INSTRUMENT IS A PARSE AND NOT A SCAN. It was `source.includes(name)` first,
// and that reading is satisfied by a MENTION: a sentence in a comment, a name in a
// test's prose, a string literal in a failure message. `timelineResumeFor` is named in
// the paragraph above, in this file, twice — so on the day a lane deleted its last real
// reader the gate would have gone on passing, held up by its own documentation of the
// defect. What is asserted is that something READS the member, so the reading is a
// property access in a parsed program: comments and string literals are not nodes, and
// a name that only appears in one cannot answer this question. The parse goes through
// this tier's own home (`test/console/typescript-source.ts`) rather than a fifth
// `createSourceFile` with a fifth set of options.
//
// WHY THE ACCESS IS NOT REQUIRED TO BE A CALL. A GETTER IS A MEMBER FOR THIS PURPOSE —
// `readRefusal`, `openSessionIds` and `isDisposed` are reads a surface performs, and a
// read nothing performs is the same dead value a call nothing makes is. Requiring a
// call would report every one of them as unread, which is a gate that fails on correct
// code within a week.
//
// WHY THE SUBJECT IS ONE CLASS AND NOT EVERY CLASS. This is the seam the defect was
// found on and the seam where the cost is highest: the registry is the ONLY way a
// surface reaches a session's store, its queue, its scheduler, or a decision taken
// about its stream, so a method here with no reader is a fact the console computes and
// never says. A tree-wide member-reachability census is a different instrument — it
// would have to answer for React props, interface members, and every class a test
// constructs. Widening it is a decision for the lane that needs it; what is claimed
// here is claimed exactly.
//
// TWO CLAIMS, AND THE SECOND IS WHY THE FIRST IS NOT MERELY "PRODUCTION READS IT".
// Running the production-only reading against the shipped class reports members that
// are deliberate assertion seams whose own doc comment says so. They are not the
// defect; a gate that failed on them would be deleted within a week. So the claims
// split:
//
//   • no member is read by NOTHING, tests included — which is exactly what
//     `timelineResumeFor` was, and is the reading that would have caught it; and
//   • a member with no PRODUCTION reader says so where it is declared, so an
//     assertion seam is a stated intention rather than a residue.
//
// The second is what keeps the first from decaying: without it, wiring a test to a
// method nobody renders would satisfy this file, which is the defect wearing a
// green check.

import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import { consoleSourceModules, readConsoleSourceModule } from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The module under audit, by the display path the walk reports it under. */
const REGISTRY_DISPLAY_PATH = "console/store/session-store-registry.ts";

/**
 * Members a reader reaches by another name, and why each is exempt.
 *
 * Deliberately tiny and deliberately reasoned. A member here is one whose consumption
 * is real but is not a property access naming it, so the parse cannot see it — never a
 * member somebody could not find a reader for.
 */
const REACHED_WITHOUT_NAMING: Readonly<Record<string, string>> = {
  // The constructor is invoked as `new SessionStoreRegistry(...)`, which names the
  // class and never the member.
  constructor: "invoked through `new`, which names the class",
};

/** One public member of the registry class, with the line it was read from. */
interface PublicMember {
  readonly name: string;
  readonly declaration: string;
  /** The comment block immediately above it, joined. Empty where it carries none. */
  readonly documentation: string;
}

/**
 * The class's public members, read out of its own source.
 *
 * A scan rather than a parse for THIS half, and the asymmetry is deliberate: the
 * question here is which members the class declares, `apps/desktop` AGENTS.md requires
 * named declarations in this tree, the console writes every class member with an
 * explicit `public` modifier, and private state is `#`-prefixed — so `public <name>(`
 * and `public get <name>(` are the whole surface, and a scan that misses one is caught
 * by the count floor below. The reading that had to become a parse is the other one:
 * a member's DECLARATION is a line the class owns, while a member's READER is anywhere
 * in five hundred modules, which is exactly where a mention is indistinguishable from
 * a use.
 */
function publicMembersOf(source: string): readonly PublicMember[] {
  const lines = source.split("\n");
  const members: PublicMember[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^\s{2}public (?:get |set |async )?([A-Za-z_$][\w$]*)\s*[(<]/u.exec(line);
    const name = match?.[1];
    if (name !== undefined) {
      members.push({
        name,
        declaration: line.trim(),
        documentation: documentationAbove(lines, index),
      });
    }
  }
  return members;
}

/**
 * The comment block directly above a declaration, walked upward until it stops.
 *
 * Both comment shapes, because the class writes both and the claim is about what a
 * reader is told rather than about which syntax told them. The walk stops at the first
 * line that is neither, so a member with no documentation gets the empty string rather
 * than the previous member's.
 */
function documentationAbove(lines: readonly string[], declarationIndex: number): string {
  const collected: string[] = [];
  for (let cursor = declarationIndex - 1; cursor >= 0; cursor -= 1) {
    const line = (lines[cursor] ?? "").trim();
    if (line.startsWith("*") || line.startsWith("/*") || line.startsWith("//")) {
      collected.unshift(line);
      continue;
    }
    break;
  }
  return collected.join(" ");
}

/** Whether a member's own documentation states that its readers are tests. */
function declaresATestOnlyReader(member: PublicMember): boolean {
  return /\btest(s)?\b/iu.test(member.documentation);
}

/**
 * Every member name one module READS off some value, as property accesses.
 *
 * Both access forms, because both are reads a surface can perform and a gate that
 * admitted one would be answerable by rewriting the other. What is deliberately NOT
 * collected is a property DECLARATION or an object-literal key: `{ timelineResumeFor:
 * … }` writes the name and reads nothing, and counting it would let a fixture that
 * merely mirrors the shape stand in for a consumer.
 */
function memberNamesReadIn(fileName: string, sourceText: string): ReadonlySet<string> {
  const parsed = parseSourceText(fileName, sourceText);
  const names = new Set<string>();
  forEachDescendant(parsed, (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      names.add(node.name.text);
      return;
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      names.add(node.argumentExpression.text);
    }
  });
  return names;
}

/**
 * The reading this file pays for once: the console parsed a single time.
 *
 * One walk rather than two, with the production subset derived from the walk's own
 * `tests: false` answer rather than from a second guess at which paths are tests — two
 * rules for that would be two rules to keep in step.
 */
const PACKAGE_PARSE_ALLOWANCE_MS = 30_000;

describe("the session-store registry publishes no member nothing reads", () => {
  let members: readonly PublicMember[] = [];
  /** Names read by production modules, the registry itself excluded. */
  let productionReads: ReadonlySet<string> = new Set();
  /** The same, plus every co-located test and support module. */
  let everyRead: ReadonlySet<string> = new Set();

  beforeAll(() => {
    const registry = consoleSourceModules().find(
      (module) => module.displayPath === REGISTRY_DISPLAY_PATH,
    );
    if (registry === undefined) {
      throw new Error(`the source walk did not reach ${REGISTRY_DISPLAY_PATH}`);
    }
    members = publicMembersOf(readConsoleSourceModule(registry));

    const productionPaths = new Set(consoleSourceModules().map((module) => module.displayPath));
    const production = new Set<string>();
    const every = new Set<string>();
    for (const module of consoleSourceModules({ tests: true })) {
      if (module.displayPath === REGISTRY_DISPLAY_PATH) {
        continue;
      }
      const read = memberNamesReadIn(module.displayPath, readConsoleSourceModule(module));
      for (const name of read) {
        every.add(name);
        if (productionPaths.has(module.displayPath)) {
          production.add(name);
        }
      }
    }
    productionReads = production;
    everyRead = every;
  }, PACKAGE_PARSE_ALLOWANCE_MS);

  it("finds the class's public surface at all", () => {
    // The vacuity floor. Every claim below quantifies over this list, so a scan that
    // matched nothing — a house style that changed, a class that moved — would report
    // a clean run over an empty set. The number is a floor and not a census: this gate
    // is about members with no reader, not about how many there are.
    expect(members.length).toBeGreaterThanOrEqual(8);
  });

  it("has a reader somewhere for every public member", () => {
    const unread = auditedMembers()
      .filter((member) => !everyRead.has(member.name))
      .map((member) => member.declaration);

    // Named in the failure rather than counted, because the remedy differs per member:
    // a method the console should call is wired to its surface, and a method nothing
    // should call is deleted. A count says neither.
    expect(unread).toStrictEqual([]);
  });

  it("says so where a member's only readers are tests", () => {
    const silentlyTestOnly = auditedMembers()
      .filter((member) => !productionReads.has(member.name))
      .filter((member) => !declaresATestOnlyReader(member))
      .map((member) => member.declaration);

    expect(silentlyTestOnly).toStrictEqual([]);
  });

  /** The members both claims quantify over: every public one the exemptions leave. */
  function auditedMembers(): readonly PublicMember[] {
    return members.filter((member) => REACHED_WITHOUT_NAMING[member.name] === undefined);
  }

  it("negative control: a planted member with no reader is reported", () => {
    // Without this the case above would pass over a scan that found members and a
    // reader set that contained every name. The planted name is deliberately one no
    // module contains.
    const planted = publicMembersOf(
      ["  public timelineResumeForNobodyAtAll(sessionId: string): void {"].join("\n"),
    );

    expect(planted.map((member) => member.name)).toStrictEqual(["timelineResumeForNobodyAtAll"]);
    expect(everyRead.has("timelineResumeForNobodyAtAll")).toBe(false);
    expect(declaresATestOnlyReader(planted[0] as PublicMember)).toBe(false);
  });

  it("negative control: a member whose only mention is a comment does not count as read", () => {
    // The reading this gate was tightened for. A scan answers `true` for all three of
    // these; the parse answers `true` only for the access — which is the difference
    // between a member something reads and a member something merely talks about.
    const mentionedInProse = memberNamesReadIn(
      "mention.ts",
      [
        "// timelineResumeFor is discussed here and read nowhere.",
        "/** @see timelineResumeFor */",
        'const explanation = "timelineResumeFor";',
        "const shape = { timelineResumeFor: undefined };",
      ].join("\n"),
    );
    const actuallyRead = memberNamesReadIn(
      "reader.ts",
      "const decision = registry.timelineResumeFor(sessionId);",
    );

    expect(mentionedInProse.has("timelineResumeFor")).toBe(false);
    expect(actuallyRead.has("timelineResumeFor")).toBe(true);
  });

  it("negative control: a getter read with no call still counts as read", () => {
    // The other side of the tightening. A call-shaped predicate would report every
    // getter on the class unread, which is a gate that fails on correct code.
    const getterRead = memberNamesReadIn("reader.ts", "const open = registry.openSessionIds;");

    expect(getterRead.has("openSessionIds")).toBe(true);
  });

  it("negative control: a member that IS read is not reported", () => {
    // The other direction. Without it, a reader set that was empty — a walk that
    // returned one module, a filter that dropped everything — would report every
    // member unread and this suite would look maximally strict while claiming nothing.
    expect(productionReads.has("timelineResumeFor")).toBe(true);
    expect(productionReads.has("requestRefresh")).toBe(true);
    // And the assertion seams really are members this second claim admits, so that
    // claim is not passing over an empty set.
    expect(
      auditedMembers().filter((member) => !productionReads.has(member.name)).length,
    ).toBeGreaterThan(0);
  });
});
