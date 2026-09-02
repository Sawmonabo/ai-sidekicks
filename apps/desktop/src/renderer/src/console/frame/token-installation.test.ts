// Getting the tokens into a document, and reading what the OS prefers.
//
// Three claims, and each is one a caller depends on rather than a description of
// what the code happens to do:
//
//   • Installation is idempotent by element id, because an auxiliary window and a
//     hot reload both re-enter it and two copies double the cascade.
//   • `"system"` REMOVES the scheme attribute rather than writing a resolved
//     value, so the sheet's `prefers-color-scheme` layer keeps deciding. A
//     resolved value written once freezes the window at whatever the OS was doing
//     at mount, and the shape of that bug is a preference that works until the
//     person changes their OS theme.
//   • `readSystemScheme` reports what the OS prefers. Nothing in the frame calls
//     it yet — it is there for a surface that wants to say which scheme is
//     actually active under `"system"` — so it is exercised here rather than left
//     to its first caller to find out whether it reads the right query.
//
// The browser tier owns the cascade half of this (a custom property that resolves
// to a real colour); happy-dom resolves nothing, so what is asserted here is
// strictly the DOM manipulation, which is the half a shim can answer honestly.

import { afterEach, describe, expect, it } from "vitest";

import { SCHEME_ATTRIBUTE, type ConsoleScheme } from "../tokens/index.js";
import {
  MERIDIAN_STYLE_ELEMENT_ID,
  applyConsoleScheme,
  installMeridianTokens,
  readSystemScheme,
} from "./token-installation.js";

/**
 * A window whose only capability is answering the media query.
 *
 * A test double for the WINDOW, never for the module under test: `readSystemScheme`
 * is the real function here. happy-dom answers `matches: false` to everything, so
 * without a double the dark arm would be unreachable and the light arm would pass
 * against an implementation that returned `"light"` unconditionally.
 */
function windowPreferring(scheme: ConsoleScheme): Window {
  const queries: string[] = [];
  const stub = {
    matchMedia: (query: string): { matches: boolean; media: string } => {
      queries.push(query);
      return { matches: scheme === "dark", media: query };
    },
    askedQueries: queries,
  };
  return stub as unknown as Window;
}

afterEach(() => {
  document.getElementById(MERIDIAN_STYLE_ELEMENT_ID)?.remove();
  document.documentElement.removeAttribute(SCHEME_ATTRIBUTE);
});

describe("token installation — one sheet per document", () => {
  it("writes the sheet once and reports that it wrote it", () => {
    expect(installMeridianTokens(document)).toBe(true);
    const styleElement = document.getElementById(MERIDIAN_STYLE_ELEMENT_ID);
    expect(styleElement).not.toBeNull();
    expect(styleElement?.textContent ?? "").toContain(":root");
  });

  it("declines the second time rather than doubling the cascade", () => {
    installMeridianTokens(document);
    expect(installMeridianTokens(document)).toBe(false);
    expect(document.querySelectorAll(`#${MERIDIAN_STYLE_ELEMENT_ID}`)).toHaveLength(1);
  });

  it("prepends, so component sheets cascade after the definitions they read", () => {
    const componentSheet = document.createElement("style");
    document.head.append(componentSheet);
    installMeridianTokens(document);
    expect(document.head.firstElementChild?.id).toBe(MERIDIAN_STYLE_ELEMENT_ID);
    componentSheet.remove();
  });

  it("negative control: the sheet is absent before anything installs it", () => {
    // Every case above reads the document by id, and every one of them would
    // pass over a sheet some earlier file left behind.
    expect(document.getElementById(MERIDIAN_STYLE_ELEMENT_ID)).toBeNull();
  });
});

describe("token installation — applying a scheme choice", () => {
  it("stamps an explicit choice on the root", () => {
    applyConsoleScheme(document, "dark");
    expect(document.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
  });

  it("removes the attribute for `system` rather than resolving it", () => {
    applyConsoleScheme(document, "dark");
    applyConsoleScheme(document, "system");
    // Not `"system"`, and not `"light"` — ABSENT. The sheet's middle layer is a
    // `prefers-color-scheme` block guarded on the attribute not being `light`, so
    // any written value stops the OS from deciding.
    expect(document.documentElement.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
  });
});

describe("token installation — reading what the OS prefers", () => {
  it("reports dark when the dark query matches", () => {
    expect(readSystemScheme(windowPreferring("dark"))).toBe("dark");
  });

  it("reports light when it does not", () => {
    expect(readSystemScheme(windowPreferring("light"))).toBe("light");
  });

  it("asks the dark query specifically", () => {
    // The two cases above pass against a function that asked
    // `(prefers-reduced-motion)` and read `matches` off the answer, which would
    // report the wrong scheme on every machine that reduces motion.
    const targetWindow = windowPreferring("dark") as unknown as { askedQueries: string[] };
    readSystemScheme(targetWindow as unknown as Window);
    expect(targetWindow.askedQueries).toStrictEqual(["(prefers-color-scheme: dark)"]);
  });
});
