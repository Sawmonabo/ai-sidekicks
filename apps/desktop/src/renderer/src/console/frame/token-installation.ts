// Getting the Meridian tokens into the document.
//
// The token sheet is GENERATED at mount from `generateMeridianCss()` rather than
// committed as a `.css` file, and that is a decision rather than a shortcut. A
// committed sheet would be a second copy of `palette.ts` — the two would drift, and
// the only defence would be a byte-diff test whose failure mode is "someone forgot
// to run the generator". Generating at mount deletes the second copy: there is one
// source of truth for every colour, and the sheet cannot disagree with it.
//
// The cost is a few kilobytes of string building once per window, before first
// paint. That is well inside the frame budget and is paid exactly once; the
// alternative costs a build step, a generated artifact in review diffs, and a class
// of drift bug.
//
// Installation is idempotent and keyed by element id, because an auxiliary window
// and a hot-module reload both re-enter this path and two copies of the sheet would
// double the cascade for no benefit.
//
// WHY THIS IS IN `frame/` AND NOT IN `tokens/`. It is the one part of the token
// story that touches a `Document`, and `tokens/` is a VOCABULARY family that node
// context reads — the generated-asset check imports it to byte-diff the emitted
// sheet against the palette it came from. A DOM-typed module inside that family
// puts `Document` and `Window` into a program that has neither, so the family
// stops being readable by the tooling that validates it. Mounting is the frame's
// job anyway: `ConsoleRoot` is the only production caller, and an auxiliary window
// re-enters through its own frame root.

import {
  SCHEME_ATTRIBUTE,
  generateMeridianCss,
  type ConsoleScheme,
  type SchemePreference,
} from "../tokens/index.js";

/** The id the generated sheet is installed under. */
export const MERIDIAN_STYLE_ELEMENT_ID = "meridian-tokens";

/**
 * Install the token sheet into a document. Returns true when it wrote the sheet,
 * false when one was already present.
 */
export function installMeridianTokens(targetDocument: Document): boolean {
  if (targetDocument.getElementById(MERIDIAN_STYLE_ELEMENT_ID) !== null) {
    return false;
  }
  const styleElement = targetDocument.createElement("style");
  styleElement.id = MERIDIAN_STYLE_ELEMENT_ID;
  styleElement.textContent = generateMeridianCss();
  // Prepended rather than appended so component stylesheets, which reference these
  // custom properties, cascade after the definitions they read.
  targetDocument.head.prepend(styleElement);
  return true;
}

/**
 * Apply a scheme choice to the document root.
 *
 * `"system"` REMOVES the attribute rather than writing a resolved value. The sheet's
 * middle layer is a `prefers-color-scheme` block guarded by
 * `:root:not([data-console-scheme="light"])`, so with no attribute the OS decides
 * and keeps deciding — a resolved value written once would freeze the window at
 * whatever the OS was doing at mount and stop following a later change.
 */
export function applyConsoleScheme(targetDocument: Document, scheme: SchemePreference): void {
  const root = targetDocument.documentElement;
  if (scheme === "system") {
    root.removeAttribute(SCHEME_ATTRIBUTE);
    return;
  }
  root.setAttribute(SCHEME_ATTRIBUTE, scheme);
}

/** What the OS currently prefers, for a surface that wants to say which is active. */
export function readSystemScheme(targetWindow: Window): ConsoleScheme {
  return targetWindow.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
