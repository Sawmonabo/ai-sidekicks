// Getting the tokens into a document, and applying a scheme choice. Installation is idempotent by
// element id, and `"system"` removes the scheme attribute rather than writing a resolved value,
// so the sheet's `prefers-color-scheme` layer keeps deciding. The browser tier owns the cascade
// half (a custom property resolving to a real color); happy-dom resolves nothing, so only the DOM
// manipulation is asserted here.

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
    // Every case above reads the document by id and would pass over a sheet an earlier file left.
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
    // Absent, not `"system"` or `"light"`: any written value stops the OS from deciding.
    expect(document.documentElement.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
  });
});
