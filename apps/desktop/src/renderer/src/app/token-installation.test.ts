// Getting the tokens into a document, and applying a scheme choice.
//
// Two claims, and each is one a caller depends on rather than a description of
// what the code happens to do:
//
//   • Installation is idempotent by element id, because an auxiliary window and a
//     hot reload both re-enter it and two copies double the cascade.
//   • `"system"` REMOVES the scheme attribute rather than writing a resolved
//     value, so the sheet's `prefers-color-scheme` layer keeps deciding. A
//     resolved value written once freezes the window at whatever the OS was doing
//     at mount, and the shape of that bug is a preference that works until the
//     person changes their OS theme.
//
// The browser tier owns the cascade half of this (a custom property that resolves
// to a real color); happy-dom resolves nothing, so what is asserted here is
// strictly the DOM manipulation, which is the half a shim can answer honestly.

import { afterEach, describe, expect, it } from "vitest";

import { SCHEME_ATTRIBUTE } from "@renderer/styles/generate-css.js";
import {
  MERIDIAN_STYLE_ELEMENT_ID,
  applyColorScheme,
  installMeridianTokens,
} from "./token-installation.js";

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
    applyColorScheme(document, "dark");
    expect(document.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
  });

  it("removes the attribute for `system` rather than resolving it", () => {
    applyColorScheme(document, "dark");
    applyColorScheme(document, "system");
    // Not `"system"`, and not `"light"` — ABSENT. The sheet's middle layer is a
    // `prefers-color-scheme` block guarded on the attribute not being `light`, so
    // any written value stops the OS from deciding.
    expect(document.documentElement.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
  });
});
