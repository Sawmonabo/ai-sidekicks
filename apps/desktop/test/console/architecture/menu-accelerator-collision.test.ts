// No console chord is one the menu bar has already taken.
//
// WHY THIS IS A GATE AND NOT A REVIEW HABIT. Electron consumes a menu accelerator
// BEFORE the renderer's key-binding table sees the keystroke, so a chord the menu owns
// is a chord no binding can ever run — and nothing reports it. The binding installs,
// the keyboard page lists it as live, `KeyBindingTable.conflictsIn` sees no second
// binding to conflict with, and the command simply never fires. That is how
// `CmdOrCtrl+Shift+T` came to sit on top of `ledger.scrollToTail`: two correct tables
// in two processes, and no reader of both.
//
// WHY A PARSE AND NOT A NEEDLE. The chords are written in `tinykeys` grammar, where
// `$mod+Shift+t` and `$mod+Shift+KeyT` are one keystroke and two strings. A text
// comparison answers "no collision" for the second spelling of a chord the menu holds,
// which is the direction that matters. Both sides go through the console's OWN parser
// and its own normalisation — the modules the service uses, imported rather than
// restated, so a change to how the console compares two chords changes this gate with
// it.
//
// WHY IT WALKS THE TREE. The claim is about every chord the console declares, and a
// hand-written list here would cover the set the day it was written. The walk reads
// every `chord:` property and every `…CHORD` constant in the console source, and fails
// on zero matches so a rename cannot quietly empty it.

import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CONSOLE_SOURCE_ROOTS,
  consoleSourceModules,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";
import { AUXILIARY_MENU_CHORDS } from "../../../src/shared/auxiliary-menu-chords.js";
import {
  normalizePressForComparison,
  parseChord,
} from "../../../src/renderer/src/console/palette/keybinding-chord.js";
import { reservedChordReason } from "../../../src/renderer/src/console/palette/keybinding-audit.js";

/** One chord literal the console declares, and where a reader finds it. */
interface DeclaredChord {
  readonly displayPath: string;
  readonly holder: string;
  readonly chord: string;
}

/** Production source only: a chord inside a suite is a fixture, not a binding. */
const CONSOLE_SCAN = { roots: [...CONSOLE_SOURCE_ROOTS], tests: false } as const;

/** A name that holds a chord. `chord:` covers the tables; `…CHORD` the constants. */
function namesAChord(name: string): boolean {
  return name === "chord" || /CHORD$/.test(name);
}

/** The declared name of `node`, when it has one that is plain text. */
function declaredName(node: ts.Node): string | undefined {
  if (
    ts.isPropertyAssignment(node) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return node.name.text;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return undefined;
}

/** Every chord literal the console source declares. */
function declaredChords(): readonly DeclaredChord[] {
  const found: DeclaredChord[] = [];
  for (const module of consoleSourceModules(CONSOLE_SCAN)) {
    const sourceFile = parseSourceText(module.displayPath, readConsoleSourceModule(module));
    forEachDescendant(sourceFile, (descendant) => {
      const name = declaredName(descendant);
      if (name === undefined || !namesAChord(name)) {
        return;
      }
      const initializer = (descendant as ts.PropertyAssignment | ts.VariableDeclaration)
        .initializer;
      if (initializer === undefined || !ts.isStringLiteral(initializer)) {
        return;
      }
      found.push({ displayPath: module.displayPath, holder: name, chord: initializer.text });
    });
  }
  return found;
}

/** The console's own comparison key for one chord, or `undefined` if it does not parse. */
function comparisonKey(chord: string): string | undefined {
  const parsed = parseChord(chord);
  return parsed.ok ? normalizePressForComparison(parsed.press) : undefined;
}

describe("the console declares no chord the menu bar takes first", () => {
  let chords: readonly DeclaredChord[] = [];

  beforeAll(() => {
    chords = declaredChords();
  });

  it("finds chords to check", () => {
    // The tripwire: a rename of the `chord` property would otherwise leave a walk that
    // passes because it inspected nothing.
    expect(chords.length).toBeGreaterThan(5);
  });

  it("collides with no auxiliary menu accelerator", () => {
    const menuKeys = new Map(
      Object.entries(AUXILIARY_MENU_CHORDS).map(([route, chord]) => [comparisonKey(chord), route]),
    );
    const collisions = chords
      .filter((declared) => menuKeys.has(comparisonKey(declared.chord)))
      .map(
        (declared) =>
          `${declared.displayPath} (${declared.holder}: "${declared.chord}") is taken by the ` +
          `"${String(menuKeys.get(comparisonKey(declared.chord)))}" menu entry`,
      );
    expect(collisions).toEqual([]);
  });

  it("reports every menu accelerator as reserved, whichever spelling it is asked in", () => {
    // The negative control for the parse: a `toLowerCase()` comparison passes the first
    // of these and fails the second, and the second is the spelling the bindings use.
    for (const chord of Object.values(AUXILIARY_MENU_CHORDS)) {
      expect(reservedChordReason(chord, "darwin")).toBeDefined();
      expect(
        reservedChordReason(
          chord.replace(/Key([A-Z])$/, (_match, letter: string) => letter.toLowerCase()),
          "darwin",
        ),
      ).toBeDefined();
    }
  });

  it("leaves a chord the menu does not hold available", () => {
    // The other half of the control: a gate that answered "reserved" for everything
    // would pass the case above and mean nothing.
    expect(reservedChordReason("$mod+Shift+KeyZ", "darwin")).toBeUndefined();
  });
});
