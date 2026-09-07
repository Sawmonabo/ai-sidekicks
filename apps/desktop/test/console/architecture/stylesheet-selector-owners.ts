// Which family declares a class name, read out of the stylesheets themselves.
//
// WHY OWNERSHIP OF A CLASS NAME IS A STRUCTURAL FACT AND NOT A STYLE PREFERENCE. Two
// families declaring the same class at equal specificity do not conflict at authoring
// time and do not conflict in any one file — they conflict in the CASCADE, where the
// later sheet wins and "later" is decided by the order the bundler emits the sheets in.
// That order is a property of the import graph, so it changes when a module moves
// between chunks. A pane can therefore be styled by another family's sheet, look right
// for as long as that sheet happens to load first, and change shape the day a body is
// moved behind a loader — with nothing in the diff mentioning either family's CSS.
//
// THIS IS MEASURED, NOT HYPOTHETICAL. `runs/pane/runs.css` and
// `workflows/pane/run/run-controls.css` both declared `.meridian-run-controls`, and the
// runs sheet's `flex-direction: column` was deciding the layout of the WORKFLOWS run
// pane. Moving the runs sheets onto a lazily imported chunk root took that pane from a
// stacked control strip to a side-by-side one and its capture from 1440x1751 to
// 1440x1172 — a 579px change in a family whose own files were untouched. That pair is
// resolved: the workflows block carries its family's prefix now, so the class is one
// family's and the cascade decides nothing.
//
// SO THE CENSUS IS A PIN RATHER THAN A BAN. Five collisions are still live in the tree,
// and resolving one means renaming a class, which changes what a committed screenshot
// reference is a picture of — so a resolution comes with regenerating references on the
// baseline host. What this model buys today is that the five are NAMED and a sixth is a
// failure.

import { basename, sep } from "node:path";

import {
  CONSOLE_DIRECTORY,
  consoleStylesheets,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { declaredClassNames } from "./stylesheet-selectors.js";

/** One stylesheet, reduced to what an ownership question needs. */
export interface StylesheetText {
  /** The family that owns the sheet: the first path segment under the console root. */
  readonly family: string;
  /** What a failure message names the sheet by. */
  readonly displayPath: string;
  readonly source: string;
}

/** A class name declared by more than one family, with the families that declare it. */
export interface SelectorCollision {
  readonly className: string;
  /** Sorted, so the report is stable across a walk whose order is the file system's. */
  readonly families: readonly string[];
}

/**
 * The console's stylesheets, each tagged with the family that owns it.
 *
 * Scoped to the console root rather than both roots the shared walk defaults to: the
 * claim is about families inside the console's own layering, and the shell subtree has
 * no families to collide between.
 */
export function consoleStylesheetTexts(): readonly StylesheetText[] {
  return consoleStylesheets({ roots: [CONSOLE_DIRECTORY] }).map((sheet) => ({
    family: sheet.relativePath.split(sep)[0] ?? basename(sheet.relativePath),
    displayPath: sheet.displayPath,
    source: readConsoleSourceModule(sheet),
  }));
}

/**
 * The class names declared by more than one family, sorted by name.
 *
 * Keyed on the FAMILY and not the file: one family splitting a class across two of its
 * own sheets is a decision inside a subtree one team owns, and the sheets load in that
 * family's own import order. Two families is the case where nobody owns the outcome.
 */
export function crossFamilyCollisions(
  sheets: readonly StylesheetText[],
): readonly SelectorCollision[] {
  const familiesByClassName = new Map<string, Set<string>>();
  for (const sheet of sheets) {
    for (const className of declaredClassNames(sheet.source)) {
      const families = familiesByClassName.get(className) ?? new Set<string>();
      families.add(sheet.family);
      familiesByClassName.set(className, families);
    }
  }
  return [...familiesByClassName]
    .filter(([, families]) => families.size > 1)
    .map(([className, families]) => ({ className, families: [...families].sort() }))
    .sort((left, right) => left.className.localeCompare(right.className));
}

/** One collision as a single comparable line, which is what a pin is compared as. */
export function formatCollision(collision: SelectorCollision): string {
  return `${collision.className}: ${collision.families.join(", ")}`;
}
