// What one module's text says, against corpora written to break the READING rather
// than the rule.
//
// `barrel-census.ts` next door judges what this module reports, and its own suite
// drives that rule. The two are separated because they fail differently, and only
// one of the two failures is visible: a rule defect judges a complete universe
// wrongly, while a reading defect drops a clause OUT of the universe — and a clause
// that is absent reads exactly like a clause that is compliant, from the findings and
// from the floor alike. Every corpus below is a shape one of the retired regular
// expressions could not see, or a claim it attributed to the wrong name.
//
// The paths here are not console paths, deliberately. This module reads TypeScript;
// which of the modules it reads is a door is the census's question, asked next door.

import { describe, expect, it } from "vitest";

import { readModuleSyntax, type ModuleSyntax } from "./barrel-syntax.js";

/** The reading of one module, which is all any corpus below needs. */
function readingOf(source: string): ModuleSyntax {
  const [reading] = readModuleSyntax([{ path: "tokens/index.ts", source, isTest: false }]);
  if (reading === undefined) {
    throw new Error("the reader answered nothing for one module");
  }
  return reading;
}

/** Each name a door publishes, paired with whether a claim decorates it. */
function claims(source: string): readonly (readonly [string, boolean])[] {
  return readingOf(source).doorSpecifiers.map((door) => [door.exportedName, door.claimed] as const);
}

describe("door reading — a claim belongs to the name it was written against", () => {
  it("reads a trailing claim as the claim of the name before the comma", () => {
    // The placement `apps/desktop/AGENTS.md` describes for the line form, and the
    // natural one to write. A reader that ended an entry at the comma carried the
    // claim to the name on the next line instead.
    expect(
      claims('export {\n  ALPHA, // Consumed by T-023p-1C-2\n  BETA,\n} from "./m.js";\n'),
    ).toStrictEqual([
      ["ALPHA", true],
      ["BETA", false],
    ]);
  });

  it("keeps a trailing claim written against the last name in a clause", () => {
    // Nothing follows it, so a reader that flushed its entry on the comma and its
    // claim with it discarded this one outright.
    expect(
      claims('export {\n  ALPHA,\n  BETA, // @consumedBy T-023p-1C-2\n} from "./m.js";\n'),
    ).toStrictEqual([
      ["ALPHA", false],
      ["BETA", true],
    ]);
  });

  it("reads a leading claim in both of the marker forms the tree writes", () => {
    // Neither is the weaker claim: the JSDoc tag additionally buys the dead-code
    // gate's per-symbol exemption, which is the only difference between them.
    expect(
      claims('export {\n  /** @consumedBy T-023p-1C-2 */\n  ALPHA,\n  BETA,\n} from "./m.js";\n'),
    ).toStrictEqual([
      ["ALPHA", true],
      ["BETA", false],
    ]);
    expect(
      claims('export {\n  // Consumed by T-023p-1C-2\n  ALPHA,\n  BETA,\n} from "./m.js";\n'),
    ).toStrictEqual([
      ["ALPHA", true],
      ["BETA", false],
    ]);
  });

  it("claims nothing for a comment that decorates no name at all", () => {
    // The fail-closed direction, and the one to be sure of: a claim the reader cannot
    // attribute leaves every name around it unclaimed, so the gate reports a door
    // line rather than exempting one nobody claimed.
    expect(
      claims('export {\n  ALPHA,\n  // Consumed by T-023p-1C-2\n} from "./m.js";\n'),
    ).toStrictEqual([["ALPHA", false]]);
  });

  it("reads a clause whose comment carries a brace", () => {
    // A clause body matched up to the first `}` ended INSIDE the comment, so the
    // whole door line — every name in it — left the census, the findings, and the
    // floor together. Not hypothetical: the branch's tags cite wire members, and
    // `core/index.ts`'s neighbouring prose already writes a braced pair.
    expect(
      claims(
        'export {\n  /** @consumedBy T-023p-1C-2 — the bound `{ retryAfter }` carries */\n  ALPHA,\n  BETA,\n} from "./m.js";\n',
      ),
    ).toStrictEqual([
      ["ALPHA", true],
      ["BETA", false],
    ]);
  });
});

describe("door reading — what a clause names, however it was written", () => {
  it("reads a module specifier written with either quotation mark", () => {
    // The same pattern that ended a clause at a brace admitted only the double-quoted
    // form, on the door side and the import side alike — so a single-quoted door line
    // vanished, and a single-quoted reader counted as no reader at all.
    expect(readingOf("export { ALPHA } from './m.js';\n").doorSpecifiers[0]?.moduleSpecifier).toBe(
      "./m.js",
    );
    expect(readingOf("import { ALPHA } from './m.js';\n").reaches).toStrictEqual([
      { moduleSpecifier: "./m.js", names: ["ALPHA"], forwarded: false },
    ]);
  });

  it("reads a clause that names no module of its own", () => {
    // A door republishing a name it imported writes no `from`, and a pattern that
    // required one saw no line there at all.
    const reading = readingOf('import { ALPHA } from "./m.js";\n\nexport { ALPHA };\n');

    expect(reading.doorSpecifiers).toStrictEqual([
      { exportedName: "ALPHA", localName: "ALPHA", moduleSpecifier: undefined, claimed: false },
    ]);
  });

  it("reads an alias by both of its names", () => {
    // The published name and the declared one, because the census resolves a symbol
    // to the module that declares it and an alias is where those two part.
    const [door] = readingOf('export { ALPHA as alpha } from "./m.js";\n').doorSpecifiers;

    expect(door?.exportedName).toBe("alpha");
    expect(door?.localName).toBe("ALPHA");
  });

  it("reads an imported alias by the name the source module calls it", () => {
    expect(readingOf('import { ALPHA as alpha } from "./m.js";\n').reaches).toStrictEqual([
      { moduleSpecifier: "./m.js", names: ["ALPHA"], forwarded: false },
    ]);
    expect(readingOf('import * as tokens from "./m.js";\n').reaches).toStrictEqual([
      { moduleSpecifier: "./m.js", names: "namespace", forwarded: false },
    ]);
  });

  it("reads a per-specifier type modifier as part of neither name", () => {
    expect(
      claims('export {\n  type Alpha, // Consumed by T-023p-1C-2\n} from "./m.js";\n'),
    ).toStrictEqual([["Alpha", true]]);
    expect(readingOf('export type { Alpha } from "./m.js";\n').doorSpecifiers[0]?.localName).toBe(
      "Alpha",
    );
  });

  it("tells a door line's reach apart from an import's", () => {
    // The distinction the census rests a whole disposition on: a door line MOVES the
    // names and an import that builds with them USES them. Not read off the module
    // they appear in — a family door writes both, and a rule that could only ask
    // whether the importer was a barrel called every symbol a door imports and builds
    // with a forward, so its claim could never retire. The case below is the other
    // half: the statement kind alone does not decide it either.
    expect(readingOf('export { ALPHA } from "./m.js";\n').reaches).toStrictEqual([
      { moduleSpecifier: "./m.js", names: ["ALPHA"], forwarded: true },
    ]);
    expect(readingOf('import { ALPHA } from "./m.js";\n').reaches).toStrictEqual([
      { moduleSpecifier: "./m.js", names: ["ALPHA"], forwarded: false },
    ]);
  });

  it("tells an import apart by what the module does with it, not by its statement", () => {
    // The re-export written in two statements. Read off the statement kind alone it
    // is an import like any other, so the census counted it as a production use of
    // `ALPHA` — which passes the door-forwarding comparison AND retires the claim on
    // the door it took the name from, both at once, for a module that consumes
    // nothing. The disposition is what the module DOES with the binding.
    // The door line the clause itself is comes second in each reading, naming no
    // module of its own — that is the pre-existing half, asserted here so the whole
    // reading is stated rather than a filtered view of it.
    expect(
      readingOf('import { ALPHA } from "./m.js";\n\nexport { ALPHA };\n').reaches,
    ).toStrictEqual([
      { moduleSpecifier: "./m.js", names: ["ALPHA"], forwarded: true },
      { moduleSpecifier: undefined, names: ["ALPHA"], forwarded: true },
    ]);
    expect(
      readingOf('import * as tokens from "./m.js";\n\nexport { tokens };\n').reaches,
    ).toStrictEqual([
      { moduleSpecifier: "./m.js", names: "namespace", forwarded: true },
      { moduleSpecifier: undefined, names: ["tokens"], forwarded: true },
    ]);
    // And an alias parts the two names: the clause republishes the LOCAL one while
    // the reach carries the name the source module declares.
    expect(
      readingOf('import { ALPHA as alpha } from "./m.js";\n\nexport { alpha };\n').reaches,
    ).toStrictEqual([
      { moduleSpecifier: "./m.js", names: ["ALPHA"], forwarded: true },
      { moduleSpecifier: undefined, names: ["alpha"], forwarded: true },
    ]);
  });

  it("keeps a republished binding a production use where the module also reads it", () => {
    // The negative control on the reading above, and the direction that matters: a
    // door that builds a table out of a name and publishes it too is a consumer, so
    // classifying it as a forward would leave the source door's claim standing with
    // no reachable retiring event — the defect this whole `forwarded` flag replaced.
    expect(
      readingOf(
        'import { ALPHA } from "./m.js";\n\nexport const table = [ALPHA];\n\nexport { ALPHA };\n',
      ).reaches,
    ).toStrictEqual([
      { moduleSpecifier: "./m.js", names: ["ALPHA"], forwarded: false },
      { moduleSpecifier: undefined, names: ["ALPHA"], forwarded: true },
    ]);
  });

  it("splits one clause that republishes some of what it took and builds with the rest", () => {
    // Per BINDING and not per statement: a rule judging the whole statement has to be
    // wrong about one half of a mixed one, and both halves are dispositions the
    // census rests on.
    expect(
      readingOf(
        'import { ALPHA, BETA } from "./m.js";\n\nexport const table = [BETA];\n\nexport { ALPHA };\n',
      ).reaches,
    ).toStrictEqual([
      { moduleSpecifier: "./m.js", names: ["BETA"], forwarded: false },
      { moduleSpecifier: "./m.js", names: ["ALPHA"], forwarded: true },
      { moduleSpecifier: undefined, names: ["ALPHA"], forwarded: true },
    ]);
  });

  it("reads an `import()` nested inside a method body", () => {
    // The shape a lazy chunk's loader is: the call is an expression inside a class
    // method, so a walk over top-level statements sees no reach at all and the door
    // it names — the one module the bundle budget requires be reached this way and
    // no other — reads as a door nothing imports.
    expect(
      readingOf(
        "export class Loader {\n  async load() {\n    const { CANVAS } = await import('./m.js');\n    return CANVAS;\n  }\n}\n",
      ).reaches,
    ).toStrictEqual([{ moduleSpecifier: "./m.js", names: "namespace", forwarded: false }]);
  });

  it("reads an `import()` written in a type position", () => {
    // How a loader narrows the shape it hands back. Erased by the compiler and still
    // a reach: a reading that took only the runtime half would under-count a door
    // named by a type alone.
    expect(
      readingOf('export type Module = Pick<typeof import("./m.js"), "CANVAS">;\n').reaches,
    ).toStrictEqual([{ moduleSpecifier: "./m.js", names: "namespace", forwarded: false }]);
  });

  it("reads no reach from an `import()` whose module is computed", () => {
    // The fail-closed direction: a specifier the text does not spell out cannot be
    // resolved to a module in the set, and inventing one would attribute a reader to
    // whichever module the reader guessed.
    expect(
      readingOf("export const load = (name: string) => import(name);\n").reaches,
    ).toStrictEqual([]);
  });

  it("reports a re-export whose set the text does not enumerate", () => {
    // Both spellings, and the negative control beside them: a door that names every
    // name it publishes is not forwarding an unnamed set, and reporting it as one
    // would make the census's own escape hatch meaningless.
    expect(readingOf('export * from "./m.js";\n').forwardsUnnamedSet).toBe(true);
    expect(readingOf('export * as tokens from "./m.js";\n').forwardsUnnamedSet).toBe(true);
    expect(readingOf('export { ALPHA } from "./m.js";\n').forwardsUnnamedSet).toBe(false);
  });
});
