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

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";

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

describe("bootstrap channel name — the console imports it and spells it nowhere", () => {
  const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

  it("finds a console tree to scan at all", () => {
    // Without this, a wrong console directory would scan nothing and the assertion
    // below would pass over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules.map((module) => module.displayPath)).toContain(
      "console/collaboration/channel-model.ts",
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
    for (const displayPath of [
      "console/collaboration/channel-model.ts",
      "console/collaboration/CreateChannel.tsx",
    ]) {
      expect(readConsoleSourceModule(moduleNamed(modules, displayPath))).toContain(
        'import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts"',
      );
    }
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
