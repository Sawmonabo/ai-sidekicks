// The barrel census's RULE and READING, against corpora written to fail them.
//
// The other half of `barrel-census.test.ts` beside this file, split from it along the
// seam the tier's other census gates already take: that file runs the rule over the
// real console, this one hands it modules written by hand. A rule that can only be
// exercised by the tree it guards is a rule whose green says nothing about whether it
// bites — every disposition below is one the console does not currently contain, and
// three of them are dispositions a family door reaches the moment it lands.
//
// Nothing here walks a directory or reads a file: `syntheticModule` is the whole of
// the input, which is why the census takes its module set as a parameter.

import { describe, expect, it } from "vitest";

import {
  barrelSpecifiers,
  censusFindings,
  doorsThatForwardNothing,
  findingLines,
  readCensus,
  starReexportingBarrels,
} from "./barrel-census.js";
import type { CensusModule } from "./barrel-syntax.js";

/** Where a console module sits in the census, and in a failure message. */
const CONSOLE_PREFIX = "src/renderer/src/console";

/** A module written by hand, for the controls. */
function syntheticModule(path: string, source: string): CensusModule {
  return { path, source, isTest: /\.test(-support)?\.tsx?$/.test(path) };
}

describe("barrel census — the rule, against corpora written to fail it", () => {
  const declaringModule = syntheticModule(
    `${CONSOLE_PREFIX}/tokens/palette.ts`,
    "export const RING_WIDTH_PX = 2;\n",
  );
  const barrel = (claim: "none" | "tag" | "comment"): CensusModule =>
    syntheticModule(
      `${CONSOLE_PREFIX}/tokens/index.ts`,
      {
        none: 'export { RING_WIDTH_PX } from "./palette.js";\n',
        tag: 'export {\n  /** @consumedBy T-023p-1C-2 */\n  RING_WIDTH_PX,\n} from "./palette.js";\n',
        comment:
          'export {\n  // Consumed by T-023p-1C-2\n  RING_WIDTH_PX,\n} from "./palette.js";\n',
      }[claim],
    );
  const testImporter = syntheticModule(
    `${CONSOLE_PREFIX}/frame/Ring.test.tsx`,
    'import { RING_WIDTH_PX } from "../tokens/index.js";\n',
  );

  it("control: the forwarding reading separates a composing door from a republishing one", () => {
    // Both directions, against planted doors rather than against whichever door the
    // console happens to compose today. A door that declares its export in place
    // forwards nothing; one carrying a single `export … from` line forwards; and a
    // star re-export forwards a set it does not name, which is forwarding too.
    const composing = syntheticModule(
      `${CONSOLE_PREFIX}/repos/index.ts`,
      'import { mountRepos } from "./RepoList.js";\n\nexport const registerRepos = () => mountRepos();\n',
    );
    const republishing = syntheticModule(
      `${CONSOLE_PREFIX}/repos/index.ts`,
      'export { RepoList } from "./RepoList.js";\n',
    );
    const starRepublishing = syntheticModule(
      `${CONSOLE_PREFIX}/repos/index.ts`,
      'export * from "./RepoList.js";\n',
    );
    expect(doorsThatForwardNothing([composing])).toStrictEqual([
      `${CONSOLE_PREFIX}/repos/index.ts`,
    ]);
    expect(doorsThatForwardNothing([republishing])).toStrictEqual([]);
    expect(doorsThatForwardNothing([starRepublishing])).toStrictEqual([]);
    // And a module that is not a door is outside the reading either way.
    expect(doorsThatForwardNothing([declaringModule])).toStrictEqual([]);
  });

  it("fails an untagged specifier whose only importer is a test", () => {
    const findings = censusFindings([declaringModule, barrel("none"), testImporter]);

    expect(findingLines(findings)).toStrictEqual([
      `${CONSOLE_PREFIX}/tokens/index.ts :: RING_WIDTH_PX — reached only by ${CONSOLE_PREFIX}/frame/Ring.test.tsx`,
    ]);
  });

  it("fails a type specifier no module imports at all, in production or in a test", () => {
    // The orphan shape, and it is worth its own case because it is the one a reader
    // is most likely to assume some other gate covers. It does not: knip counts a
    // TYPE re-export as referenced from the declaring module, and the declaring
    // module is genuinely read — `SidekickPostureMode` is used twice inside
    // `bridge/wire-shapes/sidekick-definition.ts` — so nothing outside this census can tell that
    // the DOOR LINE publishing it reaches nobody. The disposition is the door line,
    // never the symbol: retiring the type would break its own module.
    const declaringWithLocalReaders = syntheticModule(
      `${CONSOLE_PREFIX}/bridge/sidekick-definition.ts`,
      [
        'export type PostureMode = "detached" | "attached";',
        "export interface Definition {",
        "  readonly mode: PostureMode | null;",
        "}",
      ].join("\n"),
    );
    const doorPublishingIt = syntheticModule(
      `${CONSOLE_PREFIX}/bridge/index.ts`,
      'export type { PostureMode } from "./sidekick-definition.js";\n',
    );

    expect(censusFindings([declaringWithLocalReaders, doorPublishingIt])).toStrictEqual([
      {
        reason: "unclaimed",
        barrelPath: `${CONSOLE_PREFIX}/bridge/index.ts`,
        exportedName: "PostureMode",
        testOnlyImporters: [],
      },
    ]);
    // And the door stops being reported the moment a production module takes the
    // name through it, which is what makes the finding a fact about the door.
    const reader = syntheticModule(
      `${CONSOLE_PREFIX}/sessions/PostureRow.ts`,
      'import type { PostureMode } from "../bridge/index.js";\n\nexport type Row = { mode: PostureMode };\n',
    );
    expect(censusFindings([declaringWithLocalReaders, doorPublishingIt, reader])) //
      .toStrictEqual([]);
  });

  it("passes the same specifier once it names the task that will import it", () => {
    // Both forms, because the tree carries both and neither is the weaker claim: the
    // JSDoc tag additionally buys the dead-code gate's exemption, which is the only
    // difference between them.
    expect(censusFindings([declaringModule, barrel("tag"), testImporter])).toStrictEqual([]);
    expect(censusFindings([declaringModule, barrel("comment"), testImporter])).toStrictEqual([]);
  });

  it("fails a claim the task that made it has already honoured", () => {
    const doorReader = syntheticModule(
      `${CONSOLE_PREFIX}/frame/Ring.tsx`,
      'import { RING_WIDTH_PX } from "../tokens/index.js";\n',
    );

    for (const claim of ["tag", "comment"] as const) {
      expect(
        findingLines(censusFindings([declaringModule, barrel(claim), doorReader])),
      ).toStrictEqual([
        `${CONSOLE_PREFIX}/tokens/index.ts :: RING_WIDTH_PX — claimed, and already imported in production; delete the claim`,
      ]);
    }
  });

  it("leaves a claim standing while the only production reader goes around the door", () => {
    // The claim names an import through THIS door. A family reaching the module that
    // declares the symbol has not made that import, so retiring the marker there
    // would delete a claim whose event has not happened.
    const deepReader = syntheticModule(
      `${CONSOLE_PREFIX}/frame/Ring.tsx`,
      'import { RING_WIDTH_PX } from "../tokens/palette.js";\n',
    );

    expect(censusFindings([declaringModule, barrel("tag"), deepReader])).toStrictEqual([]);
  });

  it("passes a specifier a production module imports through the barrel", () => {
    const productionImporter = syntheticModule(
      `${CONSOLE_PREFIX}/frame/Ring.tsx`,
      'import { RING_WIDTH_PX } from "../tokens/index.js";\n',
    );

    expect(
      censusFindings([declaringModule, barrel("none"), testImporter, productionImporter]),
    ).toStrictEqual([]);
  });

  it("counts a barrel that imports and builds as a reader, and a re-export as none", () => {
    // The two things a family door does with a name, and only one of them is a read.
    // a family door that imports a token to build its own table reads it — the
    // claim's own retiring event — while a door writing `export … from`
    // moves the name and consumes nothing. A rule that asked only whether the importer
    // was a barrel called both of them forwarding, so a symbol whose one production
    // consumer is a door stayed claimed forever, and knip — which counts the reference
    // either way — failed the run on the tag that could never be retired.
    const doorThatBuilds = syntheticModule(
      `${CONSOLE_PREFIX}/frame/index.ts`,
      'import { RING_WIDTH_PX } from "../tokens/index.js";\n\nexport const ring = { width: RING_WIDTH_PX };\n',
    );
    const doorThatForwards = syntheticModule(
      `${CONSOLE_PREFIX}/frame/index.ts`,
      'export { RING_WIDTH_PX } from "../tokens/index.js";\n',
    );

    expect(findingLines(censusFindings([declaringModule, barrel("tag"), doorThatBuilds]))).toEqual(
      expect.arrayContaining([
        `${CONSOLE_PREFIX}/tokens/index.ts :: RING_WIDTH_PX — claimed, and already imported in production; delete the claim`,
      ]),
    );
    expect(censusFindings([declaringModule, barrel("tag"), doorThatForwards])).toStrictEqual([
      {
        reason: "unclaimed",
        barrelPath: `${CONSOLE_PREFIX}/frame/index.ts`,
        exportedName: "RING_WIDTH_PX",
        testOnlyImporters: [],
      },
    ]);
  });

  it("passes a specifier whose only production reader reaches it through `import()`", () => {
    // A lazily-loaded chunk's door is reached by `import()` AND BY NOTHING ELSE — that
    // is what makes it the bundler's split point — so a census blind to that form
    // reports the one door the bundle budget requires as the one door nothing
    // consumes, and the disposition it invites is deleting the split.
    const lazyLoader = syntheticModule(
      `${CONSOLE_PREFIX}/tokens/palette-loader.ts`,
      "export const load = async () => (await import('./index.js')).RING_WIDTH_PX;\n",
    );

    expect(censusFindings([declaringModule, barrel("none"), lazyLoader])).toStrictEqual([]);
  });

  it("passes a specifier a production module imports through a different door", () => {
    // The disposition that changes nothing: the symbol has a reader, reaching it by
    // the module that declares it rather than by this barrel. A census failing this
    // would be counting doors rather than readers.
    const deepImporter = syntheticModule(
      `${CONSOLE_PREFIX}/frame/Ring.tsx`,
      'import { RING_WIDTH_PX } from "../tokens/palette.js";\n',
    );

    expect(
      censusFindings([declaringModule, barrel("none"), testImporter, deepImporter]),
    ).toStrictEqual([]);
  });

  it("reads an alias by the name the declaring module gave it", () => {
    const aliasingBarrel = syntheticModule(
      `${CONSOLE_PREFIX}/tokens/index.ts`,
      'export { RING_WIDTH_PX as ringWidth } from "./palette.js";\n',
    );
    const deepImporter = syntheticModule(
      `${CONSOLE_PREFIX}/frame/Ring.tsx`,
      'import { RING_WIDTH_PX } from "../tokens/palette.js";\n',
    );

    expect(censusFindings([declaringModule, aliasingBarrel, deepImporter])).toStrictEqual([]);
    expect(findingLines(censusFindings([declaringModule, aliasingBarrel]))).toStrictEqual([
      `${CONSOLE_PREFIX}/tokens/index.ts :: ringWidth — reached only by no importer at all`,
    ]);
  });

  it("does not let one barrel's re-export of another stand in for a reader", () => {
    // A door forwarding to a door moves a name; it does not read one. Both specifiers
    // are findings rather than one carrying the other — which is also why the console
    // forbids the chain outright, in `console-no-barrel-chain`.
    const forwardingBarrel = syntheticModule(
      `${CONSOLE_PREFIX}/frame/index.ts`,
      'export { RING_WIDTH_PX } from "../tokens/index.js";\n',
    );

    expect(
      findingLines(censusFindings([declaringModule, barrel("none"), forwardingBarrel])),
    ).toEqual(
      expect.arrayContaining([
        `${CONSOLE_PREFIX}/tokens/index.ts :: RING_WIDTH_PX — reached only by no importer at all`,
        `${CONSOLE_PREFIX}/frame/index.ts :: RING_WIDTH_PX — reached only by no importer at all`,
      ]),
    );
  });

  it("reads a multi-task claim as one entry, commas and all", () => {
    const multiTagged = syntheticModule(
      `${CONSOLE_PREFIX}/tokens/index.ts`,
      'export {\n  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */\n  RING_WIDTH_PX,\n  RING_GAP_PX,\n} from "./palette.js";\n',
    );

    // The tag covers the entry it precedes and no more: the second name is untagged
    // and unread, so it is still a finding.
    expect(findingLines(censusFindings([declaringModule, multiTagged]))).toStrictEqual([
      `${CONSOLE_PREFIX}/tokens/index.ts :: RING_GAP_PX — reached only by no importer at all`,
    ]);
  });

  it("reports both halves of a stale claim and the neighbour it used to exempt", () => {
    // Where a misattributed claim lands in the RULE, and the smallest corpus a
    // comma-flushing reader passed WHOLE: the claim moved one name down, so
    // `RING_WIDTH_PX` read as unclaimed with a production reader and `RING_GAP_PX`
    // read as claimed with none. Two findings in one clause, and neither reported.
    const staleClaim = syntheticModule(
      `${CONSOLE_PREFIX}/tokens/index.ts`,
      'export {\n  RING_WIDTH_PX, // Consumed by T-023p-1C-2\n  RING_GAP_PX,\n} from "./palette.js";\n',
    );
    const doorReader = syntheticModule(
      `${CONSOLE_PREFIX}/frame/Ring.tsx`,
      'import { RING_WIDTH_PX } from "../tokens/index.js";\n',
    );

    expect(findingLines(censusFindings([declaringModule, staleClaim, doorReader]))).toStrictEqual([
      `${CONSOLE_PREFIX}/tokens/index.ts :: RING_WIDTH_PX — claimed, and already imported in production; delete the claim`,
      `${CONSOLE_PREFIX}/tokens/index.ts :: RING_GAP_PX — reached only by no importer at all`,
    ]);
  });

  it("censuses a door line that names no module of its own", () => {
    // A barrel republishing a name it imported writes no `from`, and a pattern that
    // required one saw no line there. It publishes a name, so it needs a reader or a
    // claim like any other — and the name's declaring identity is the door itself.
    const republishingBarrel = syntheticModule(
      `${CONSOLE_PREFIX}/tokens/index.ts`,
      'import { RING_WIDTH_PX } from "./palette.js";\n\nexport { RING_WIDTH_PX };\n',
    );
    const doorReader = syntheticModule(
      `${CONSOLE_PREFIX}/frame/Ring.tsx`,
      'import { RING_WIDTH_PX } from "../tokens/index.js";\n',
    );

    expect(findingLines(censusFindings([declaringModule, republishingBarrel]))).toStrictEqual([
      `${CONSOLE_PREFIX}/tokens/index.ts :: RING_WIDTH_PX — reached only by no importer at all`,
    ]);
    expect(censusFindings([declaringModule, republishingBarrel, doorReader])).toStrictEqual([]);
  });

  it("names a star re-export rather than censusing fewer specifiers", () => {
    const starBarrel = syntheticModule(
      `${CONSOLE_PREFIX}/tokens/index.ts`,
      'export * from "./palette.js";\n',
    );

    expect(starReexportingBarrels([declaringModule, starBarrel])).toStrictEqual([
      `${CONSOLE_PREFIX}/tokens/index.ts`,
    ]);
    expect(starReexportingBarrels([declaringModule, barrel("none")])).toStrictEqual([]);
  });

  it("answers the four questions off one reading exactly as it answers them off four", () => {
    // `readCensus` exists so the gate next door parses the console once instead of
    // four times, and a faster reading that answered differently would be a worse
    // gate rather than a quicker one. Both corpora, because the interesting halves
    // are opposite: the failing one has to carry the same finding and the clean one
    // has to carry the same silence.
    const starBarrel = syntheticModule(
      `${CONSOLE_PREFIX}/repos/index.ts`,
      'export * from "./RepoList.js";\n',
    );
    for (const corpus of [
      [declaringModule, barrel("none"), testImporter, starBarrel],
      [declaringModule, barrel("tag"), testImporter],
    ]) {
      expect(readCensus(corpus)).toStrictEqual({
        specifiers: barrelSpecifiers(corpus),
        doorsForwardingNothing: doorsThatForwardNothing(corpus),
        unenumerableForwarders: starReexportingBarrels(corpus),
        findings: censusFindings(corpus),
      });
    }
  });

  it("negative control: the four questions are four different answers, not one repeated", () => {
    // Without this the equivalence above would hold over a corpus where every answer
    // was the same empty list, and would go on holding if `readCensus` returned one
    // reading under four names.
    const corpus = [declaringModule, barrel("none"), testImporter];
    const reading = readCensus(corpus);
    expect(reading.specifiers.length).toBeGreaterThan(0);
    expect(reading.findings.length).toBeGreaterThan(0);
    expect(reading.doorsForwardingNothing).toStrictEqual([]);
    expect(reading.unenumerableForwarders).toStrictEqual([]);
  });
});
