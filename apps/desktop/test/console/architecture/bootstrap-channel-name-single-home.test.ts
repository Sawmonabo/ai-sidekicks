// The bootstrap channel's name is the wire's word, and the console spells it nowhere.
//
// `@ai-sidekicks/contracts` declares `MAIN_CHANNEL_NAME`, and it is the producer's
// own value: the control plane's channel-list projection and the daemon's session
// projector both emit the bootstrap row under it. The collaboration family had a
// second declaration of the same string, so two modules recognised the bootstrap
// channel by a word the console had written down for itself rather than by the word
// the wire carries. Nothing was wrong on the day it was written and nothing would
// break loudly on the day it stopped being true: the ordering rule would quietly
// stop lifting the bootstrap row, and the create-channel policy statement would go
// on naming a reserved name that had been renamed.
//
// WHY A TEXT SCAN AND NOT A TYPE. A copy of a string constant is type-compatible
// with the original — that is what makes it invisible — so the compiler has nothing
// to say. The only way to state "this value is imported, never re-spelled" is to
// read the source and look for the spelling.
//
// THE VALUE COMES FROM CONTRACTS, NOT FROM HERE. This file imports
// `MAIN_CHANNEL_NAME` and derives its patterns from it, so the day the wire
// vocabulary changes the tripwire moves with it. A hardcoded `"main"` here would be
// a third copy of the thing being forbidden.
//
// THE LANDMARK ROLE DOES NOT COLLIDE WITH THIS. `AppFrame.tsx` marks the surface
// region with the `<main>` ELEMENT, which is a tag and not a string literal, so the
// document vocabulary and the wire vocabulary do not meet in this scan. If a
// surface ever needs `role="main"` it needs the element instead.

// THE TWO HALVES ASK TWO DIFFERENT QUESTIONS AND TAKE TWO DIFFERENT INSTRUMENTS.
// "Does this text spell the word" is a question about TEXT, and a substring scan is
// the whole of it. "Does this module import the binding" is a question about a
// DECLARATION, and it was being asked with `String.includes` over the statement as
// one runs of characters — which passes on a header comment that merely quotes the
// import, and fails the moment a second named import makes Prettier wrap the
// statement across lines. Both directions are false verdicts about a module nothing
// changed in. So the second half goes through `barrel-syntax.ts`'s reader, which is
// this tier's one home for "what names does this module take from that module" and
// already answers it from the parse rather than from the text.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { readModuleSyntax } from "./barrel-syntax.js";

/**
 * The three ways this tree can quote a string, applied to the contracts value.
 *
 * Built from the value rather than written out, and matched as plain substrings
 * rather than through a constructed pattern: a regular expression assembled from a
 * value has to escape it first, and an escaper is a second implementation of a job
 * nothing here needs done.
 */
const BOOTSTRAP_NAME_SPELLINGS: readonly string[] = ['"', "'", "`"].map(
  (quote) => `${quote}${MAIN_CHANNEL_NAME}${quote}`,
);

/**
 * Every way `source` spells the bootstrap channel name as a literal, or `[]`.
 *
 * A pure function over text rather than a loop inside a test, so the negative
 * controls below can drive it with bodies whose verdict is known and the checker is
 * proved to bite without planting a violation in the tree.
 */
function spelledBootstrapNames(source: string): readonly string[] {
  return BOOTSTRAP_NAME_SPELLINGS.filter((spelling) => source.includes(spelling));
}

/**
 * The identifier the contracts package publishes the bootstrap channel's name under.
 *
 * A literal, because an identifier cannot be derived from the value it is bound to —
 * and it cannot outlive the name it spells either: this file's own
 * `import { MAIN_CHANNEL_NAME }` above is the first thing a rename in
 * `@ai-sidekicks/contracts` breaks, so the compiler brings whoever renames it here.
 */
const BOOTSTRAP_NAME_BINDING = "MAIN_CHANNEL_NAME";

/** The package that publishes it, as an importer spells it. */
const CONTRACTS_PACKAGE = "@ai-sidekicks/contracts";

/** The modules whose job is to recognise the bootstrap row. */
const BOOTSTRAP_CHANNEL_READERS: readonly [string, ...string[]] = [
  "console/collaboration/channels/channel-model.ts",
  "console/collaboration/channels/CreateChannel.tsx",
];

/**
 * Whether `source` TAKES the contracts binding, as a declaration rather than as text.
 *
 * `forwarded` is what separates a module that reads the value from a door that merely
 * moves it: a barrel writing `export { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts"`
 * republishes the name and recognises no channel with it, and this claim is about
 * recognition.
 */
function importsBootstrapName(fileName: string, source: string): boolean {
  const [syntax] = readModuleSyntax([{ path: fileName, source, isTest: false }]);
  if (syntax === undefined) {
    // The reader answers one entry per module handed to it, so this is unreachable —
    // and asserting it is what keeps a future reader that filtered its input from
    // turning every case below into a silent `false`.
    throw new Error(`the module reader returned nothing for ${fileName}`);
  }
  return syntax.reaches.some(
    (reach) =>
      reach.moduleSpecifier === CONTRACTS_PACKAGE &&
      !reach.forwarded &&
      reach.names !== "namespace" &&
      reach.names.includes(BOOTSTRAP_NAME_BINDING),
  );
}

describe("bootstrap channel name — the console imports it and spells it nowhere", () => {
  const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

  it("finds a console tree to scan at all", () => {
    // Without this, a wrong console directory would scan nothing and the assertion
    // below would pass over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules.map((module) => module.displayPath)).toContain(
      "console/collaboration/channels/channel-model.ts",
    );
  });

  it("spells the name in no module", () => {
    const spellers = modules
      .map((module) => ({
        module,
        spellings: spelledBootstrapNames(readConsoleSourceModule(module)),
      }))
      .filter((entry) => entry.spellings.length > 0)
      .map((entry) => `${entry.module.displayPath}: ${entry.spellings.join(", ")}`);
    expect(spellers).toStrictEqual([]);
  });

  it("the modules that recognise the bootstrap channel import the contracts value", () => {
    // The other half of the claim, and the half a scan for absence cannot make: a
    // family that deleted its copy and then stopped recognising the bootstrap
    // channel altogether would satisfy the assertion above.
    for (const displayPath of BOOTSTRAP_CHANNEL_READERS) {
      const module = moduleNamed(modules, displayPath);
      expect({
        displayPath,
        imported: importsBootstrapName(displayPath, readConsoleSourceModule(module)),
      }).toStrictEqual({ displayPath, imported: true });
    }
  });

  it("negative control: a mention inside a comment is not an import", () => {
    // The false GREEN the substring scan shipped. A module can delete the import and
    // every use of the value, keep a header sentence that quotes the statement, and
    // satisfy both halves at once — the absence half because a comment spells no
    // literal, and this half because the characters are on the page. Run against a
    // real module's text with its import removed rather than against a hand-written
    // fixture, so what is asserted is a verdict about source this tree actually has.
    const [displayPath] = BOOTSTRAP_CHANNEL_READERS;
    const source = readConsoleSourceModule(moduleNamed(modules, displayPath));
    const commentedOut = source
      .split("\n")
      .map((line) => (line.startsWith("import { MAIN_CHANNEL_NAME }") ? `// ${line}` : line))
      .join("\n");
    expect(commentedOut).not.toBe(source);
    expect(commentedOut).toContain(BOOTSTRAP_NAME_BINDING);
    expect(importsBootstrapName(displayPath, commentedOut)).toBe(false);
  });

  it("negative control: a wrapped multi-line import is one", () => {
    // The false RED. Nothing about the module changes when a second named import
    // makes Prettier break the statement over four lines, and the substring scan
    // failed on it. Built by rewriting the real module's own statement, so the shape
    // under test is the shape Prettier would write here.
    const [displayPath] = BOOTSTRAP_CHANNEL_READERS;
    const source = readConsoleSourceModule(moduleNamed(modules, displayPath));
    const wrapped = source.replace(
      /^import \{ MAIN_CHANNEL_NAME \} from "@ai-sidekicks\/contracts";$/mu,
      [
        "import {",
        "  MAIN_CHANNEL_NAME,",
        "  type ChannelListResponseChannel,",
        '} from "@ai-sidekicks/contracts";',
      ].join("\n"),
    );
    expect(wrapped).not.toBe(source);
    expect(importsBootstrapName(displayPath, wrapped)).toBe(true);
  });

  it("negative control: it catches the consumer-side copy this rule was written for", () => {
    // The declaration the collaboration family carried, and the fixture member that
    // scripted the same word into a scripted `channel.list` reply. Run against the
    // predicate rather than against a planted file, so the case states what would
    // fail without writing the violation back into the tree.
    expect(spelledBootstrapNames('export const MAIN_CHANNEL_NAME = "main";')).toStrictEqual([
      '"main"',
    ]);
    expect(spelledBootstrapNames("    name: 'main',")).toStrictEqual(["'main'"]);
    expect(spelledBootstrapNames("the reserved `main` channel")).toStrictEqual(["`main`"]);
  });

  it("negative control: it passes what is not a spelling of the name", () => {
    // A longer identifier that contains the letters, the import that is the whole
    // point of the rule, and the interpolation the create-channel copy renders
    // through — none of which is the console writing the word down.
    expect(spelledBootstrapNames('const CHANNEL_MAIN = "channel-main";')).toStrictEqual([]);
    expect(
      spelledBootstrapNames('import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";'),
    ).toStrictEqual([]);
    expect(spelledBootstrapNames("`\\`${MAIN_CHANNEL_NAME}\\` is reserved`")).toStrictEqual([]);
  });
});
