// Every console dialog is `modal="trap-focus"`, and this is what holds it to that.
//
// THE DEFAULT IS THE WRONG ONE. Base UI's `Dialog.Root` defaults to fully modal, which
// locks body scroll and hangs `aria-hidden` on the background. `Spec-023 §Console
// Libraries` adopts this family with "every popup portals into our overlay root; no
// body scroll lock; the shell applies `inert` to the app root while a modal is open" —
// so the mode the console uses is `trap-focus`, and the structural half of the guard is
// the shell's `AppFrame` `modalOverlayOpen`, armed by whichever family owns the card.
//
// WHICH MAKES OMITTING IT INVISIBLE. A dialog written without the prop looks right,
// behaves nearly right, and differs in exactly the two places nobody clicks: the page
// behind it stops scrolling, and the accessibility tree hides a background the shell
// was never told to inert. The onboarding walkthrough shipped that way, and what
// reported it was a person reading the JSX beside the sign-in card's.
//
// A CLASS, NOT A ROSTER. The claim is about every `Dialog.Root` under `console/`
// rather than about the seven that exist today, because the next one is written by
// copying one of them and the copy is where the prop goes missing.
//
// `AlertDialog.Root` IS DELIBERATELY OUT OF SCOPE, and by construction rather than by
// choice: `@base-ui/react` declares it as `Omit<DialogRoot.Props, 'modal' | …>`, so it
// takes no `modal` prop at all and a gate demanding one would demand something that
// does not compile.
//
// THE INSTRUMENT IS THE PARSER. A text scan for `Dialog.Root` counts this file's own
// prose and the JSX closing tags, and would report a dialog written across two lines
// as though it carried nothing.

import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The element every console dialog opens with, spelled as the JSX names it. */
const DIALOG_ROOT_TAG = "Dialog.Root";

/** The one mode `Spec-023 §Console Libraries` adopts. */
const REQUIRED_MODAL_MODE = "trap-focus";

/** The budget this file states rather than inherits; `source-walk-chokepoint.test.ts`'s figure. */
const CONSOLE_PARSE_ALLOWANCE_MS = 30_000;

vi.setConfig({ testTimeout: CONSOLE_PARSE_ALLOWANCE_MS, hookTimeout: CONSOLE_PARSE_ALLOWANCE_MS });

/**
 * The floor the populated-tier claim is measured against.
 *
 * Seven dialogs carry the prop on this tree — the palette, the sign-in card, the
 * sidekick attach form, the onboarding walkthrough, the repository attach and bind
 * forms, and the invite confirmation. The floor sits BELOW that count on purpose: this
 * is a use-at-all tripwire and not a census, so a family retiring one dialog does not
 * fail a gate whose claim is about a different thing. What it refuses is the console
 * that "omits nothing" because it stopped opening dialogs at all — a gate asserting
 * only "nobody omits it" would pass over exactly that.
 */
const DIALOG_SITE_FLOOR = 4;

/** Where a `Dialog.Root` opens, and whether it declared the adopted mode. */
interface DialogSite {
  readonly line: number;
  readonly declaresTrapFocus: boolean;
}

/**
 * Every `Dialog.Root` one module opens, with what its `modal` prop says.
 *
 * A site counts as declaring the mode only on a plain string attribute — `modal` with
 * no initializer is boolean `true`, and an expression initializer is a value this gate
 * cannot read, so both are reported rather than admitted. That is the fail-closed
 * direction: a dialog whose mode is computed is a dialog whose mode is unreviewable.
 */
export function dialogSites(source: string, fileName: string): readonly DialogSite[] {
  const parsed = parseSourceText(fileName, source);
  const sites: DialogSite[] = [];
  forEachDescendant(parsed, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) {
      return;
    }
    if (node.tagName.getText(parsed) !== DIALOG_ROOT_TAG) {
      return;
    }
    sites.push({
      line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
      declaresTrapFocus: node.attributes.properties.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(parsed) === "modal" &&
          attribute.initializer !== undefined &&
          ts.isStringLiteral(attribute.initializer) &&
          attribute.initializer.text === REQUIRED_MODAL_MODE,
      ),
    });
  });
  return sites;
}

/** One dialog in the shipped console, named the way a failure should name it. */
interface LocatedDialogSite extends DialogSite {
  readonly displayPath: string;
}

/** Every dialog the console opens, across every family. */
function consoleDialogSites(): readonly LocatedDialogSite[] {
  return consoleSourceModules({ roots: [CONSOLE_DIRECTORY] }).flatMap((module) =>
    dialogSites(readConsoleSourceModule(module), module.relativePath).map((site) => ({
      ...site,
      displayPath: module.displayPath,
    })),
  );
}

describe("the console's dialog mode", () => {
  // Read ONCE for both claims. The walk parses every console module, and the two
  // cases below are two readings of the same list — a second walk would double the
  // one cost this file has, for nothing.
  let sites: readonly LocatedDialogSite[] = [];
  beforeAll(() => {
    sites = consoleDialogSites();
  });

  it("declares the adopted mode at every dialog it opens", () => {
    const offenders = sites
      .filter((site) => !site.declaresTrapFocus)
      .map((site) => `${site.displayPath}:${String(site.line)}`);
    expect(
      offenders,
      `each of these opens a Dialog.Root without modal="${REQUIRED_MODAL_MODE}" — the ` +
        "library default locks body scroll, which Spec-023 §Console Libraries forbids",
    ).toStrictEqual([]);
  });

  // The populated half. Without it the claim above is satisfied by a console with no
  // dialogs in it at all.
  it("still opens dialogs, in more than one family", () => {
    expect(sites.length).toBeGreaterThanOrEqual(DIALOG_SITE_FLOOR);
  });
});

describe("the dialog reader, against planted text", () => {
  // The planted failure: the shape a dialog written from the library's own examples
  // has, and the shape the onboarding walkthrough shipped with.
  it("reports a dialog that declares no mode", () => {
    expect(
      dialogSites("const card = <Dialog.Root open={open}>{body}</Dialog.Root>;", "planted.tsx"),
    ).toStrictEqual([{ line: 1, declaresTrapFocus: false }]);
  });

  it("reports a bare `modal`, which is the fully-modal default spelled out", () => {
    expect(dialogSites("const card = <Dialog.Root modal />;", "planted.tsx")).toStrictEqual([
      { line: 1, declaresTrapFocus: false },
    ]);
  });

  it("reports a mode this gate cannot read rather than admitting it", () => {
    expect(dialogSites("const card = <Dialog.Root modal={mode} />;", "planted.tsx")).toStrictEqual([
      { line: 1, declaresTrapFocus: false },
    ]);
  });

  it("admits the adopted mode", () => {
    expect(
      dialogSites('const card = <Dialog.Root modal="trap-focus" open={open} />;', "planted.tsx"),
    ).toStrictEqual([{ line: 1, declaresTrapFocus: true }]);
  });

  it("mints no site from a mention in a comment or a string", () => {
    expect(
      dialogSites('// a Dialog.Root here\nconst tag = "Dialog.Root";\n', "planted.tsx"),
    ).toStrictEqual([]);
  });

  it("leaves AlertDialog.Root alone, which takes no modal prop at all", () => {
    expect(
      dialogSites("const confirm = <AlertDialog.Root>{body}</AlertDialog.Root>;", "planted.tsx"),
    ).toStrictEqual([]);
  });

  it("names every dialog in a module rather than the first", () => {
    expect(
      dialogSites(
        'const one = <Dialog.Root modal="trap-focus" />;\nconst two = <Dialog.Root />;\n',
        "planted.tsx",
      ),
    ).toStrictEqual([
      { line: 1, declaresTrapFocus: true },
      { line: 2, declaresTrapFocus: false },
    ]);
  });
});
