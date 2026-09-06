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
// rendered by nothing. Every gate was green, and the version-skew refusal a console
// talking to an older responder is permanently in reached no screen. THE GATE NEEDED
// WIDENING — this file is that widening, and it is the console-wide claim rather than
// a second assertion inside the store family's own suite, because a family asserting
// its own reachability is asserting it about the file it is written in.
//
// WHY THE SUBJECT IS ONE CLASS AND NOT EVERY CLASS. This is the seam the defect was
// found on and the seam where the cost is highest: the registry is the ONLY way a
// surface reaches a session's store, its queue, its scheduler, or a decision taken
// about its stream, so a method here with no reader is a fact the console computes and
// never says. A tree-wide member-reachability census is a different instrument — it
// needs a parser rather than a scan, and it would have to answer for React props,
// interface members, and every class a test constructs. Widening it is a decision for
// the lane that needs it; what is claimed here is claimed exactly.
//
// A GETTER IS A METHOD FOR THIS PURPOSE. `readRefusal` and `openSessionIds` are reads
// a surface performs, and a read nothing performs is the same dead value a call
// nothing makes is.
//
// TWO CLAIMS, AND THE SECOND IS WHY THE FIRST IS NOT MERELY "PRODUCTION READS IT".
// Running the production-only reading against the shipped class reports four members
// — `openCount`, `listenerCount`, `refreshCountFor`, `applyDrainCountFor` — and every
// one of them is a deliberate assertion seam whose own doc comment says so. They are
// not the defect; a gate that failed on them would be deleted within a week. So the
// claims split:
//
//   • no member is read by NOTHING, tests included — which is exactly what
//     `timelineResumeFor` was, and is the reading that would have caught it; and
//   • a member with no PRODUCTION reader says so where it is declared, so an
//     assertion seam is a stated intention rather than a residue.
//
// The second is what keeps the first from decaying: without it, wiring a test to a
// method nobody renders would satisfy this file, which is the defect wearing a
// green check.

import { beforeAll, describe, expect, it } from "vitest";

import { consoleSourceModules, readConsoleSourceModule } from "../console-source-modules.js";

/** The module under audit, by the display path the walk reports it under. */
const REGISTRY_DISPLAY_PATH = "console/store/session-store-registry.ts";

/**
 * Members a reader reaches by another name, and why each is exempt.
 *
 * Deliberately tiny and deliberately reasoned. A member here is one whose consumption
 * is real but is not a source-text occurrence of its own name, so a scan cannot see it
 * — never a member somebody could not find a reader for.
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
 * A scan rather than a parse, and the shape it keys on is exact: `apps/desktop`
 * AGENTS.md requires named declarations in this tree, the console writes every class
 * member with an explicit `public` modifier, and private state is `#`-prefixed — so
 * `public <name>(` and `public get <name>(` are the whole surface. A member written
 * some other way is invisible to this scan, which is why the case below asserts a
 * floor on the count: a scan that found nothing would otherwise pass.
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

describe("the session-store registry publishes no member nothing reads", () => {
  let members: readonly PublicMember[] = [];
  /** Every production module except the registry itself, as text. */
  let productionSources: readonly string[] = [];
  /** The same set plus every co-located test and support module. */
  let everySource: readonly string[] = [];

  beforeAll(() => {
    const registry = consoleSourceModules().find(
      (module) => module.displayPath === REGISTRY_DISPLAY_PATH,
    );
    if (registry === undefined) {
      throw new Error(`the source walk did not reach ${REGISTRY_DISPLAY_PATH}`);
    }
    members = publicMembersOf(readConsoleSourceModule(registry));
    const readersOf = (scanTests: boolean): readonly string[] =>
      consoleSourceModules({ tests: scanTests })
        .filter((module) => module.displayPath !== REGISTRY_DISPLAY_PATH)
        .map((module) => readConsoleSourceModule(module));
    productionSources = readersOf(false);
    everySource = readersOf(true);
  });

  it("finds the class's public surface at all", () => {
    // The vacuity floor. Every claim below quantifies over this list, so a scan that
    // matched nothing — a house style that changed, a class that moved — would report
    // a clean run over an empty set. The number is a floor and not a census: this gate
    // is about members with no reader, not about how many there are.
    expect(members.length).toBeGreaterThanOrEqual(8);
  });

  it("has a reader somewhere for every public member", () => {
    const unread = auditedMembers()
      .filter((member) => !everySource.some((source) => source.includes(member.name)))
      .map((member) => member.declaration);

    // Named in the failure rather than counted, because the remedy differs per member:
    // a method the console should call is wired to its surface, and a method nothing
    // should call is deleted. A count says neither.
    expect(unread).toStrictEqual([]);
  });

  it("says so where a member's only readers are tests", () => {
    const silentlyTestOnly = auditedMembers()
      .filter((member) => !productionSources.some((source) => source.includes(member.name)))
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
    // reader set that contained every name — which is exactly what a `.includes` over
    // the whole tree does for a short or common identifier. The planted name is
    // deliberately one no module contains.
    const planted = publicMembersOf(
      ["  public timelineResumeForNobodyAtAll(sessionId: string): void {"].join("\n"),
    );

    expect(planted.map((member) => member.name)).toStrictEqual(["timelineResumeForNobodyAtAll"]);
    expect(everySource.some((source) => source.includes("timelineResumeForNobodyAtAll"))).toBe(
      false,
    );
    expect(declaresATestOnlyReader(planted[0] as PublicMember)).toBe(false);
  });

  it("negative control: a member that IS read is not reported", () => {
    // The other direction. Without it, a reader set that was empty — a walk that
    // returned one module, a filter that dropped everything — would report every
    // member unread and this suite would look maximally strict while claiming nothing.
    expect(productionSources.some((source) => source.includes("timelineResumeFor"))).toBe(true);
    expect(productionSources.some((source) => source.includes("requestRefresh"))).toBe(true);
    // And the four assertion seams really are the ones the second claim admits, so
    // that claim is not passing over an empty set.
    expect(
      auditedMembers().filter(
        (member) => !productionSources.some((source) => source.includes(member.name)),
      ).length,
    ).toBeGreaterThan(0);
  });
});
