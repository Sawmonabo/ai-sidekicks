// The media features a person's operating system sets, emulated for the browser-mode tiers through
// CDP, which those tiers pin to Chromium. Each call replaces every emulated feature at once.

import { cdp } from "vitest/browser";

import { type ColorScheme } from "#renderer/styles/tokens.js";

/**
 * Puts the page in a scheme the way a person's operating system does.
 *
 * Not by stamping the scheme attribute: `AppProviders` writes its own store's preference into it
 * in a layout effect, so a value set before mounting is overwritten with the default `"system"`
 * on first paint. Emulating `prefers-color-scheme` drives the layer a default install uses.
 */
export async function emulateSystemScheme(scheme: ColorScheme): Promise<void> {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: scheme }],
  });
}

/** Asks for reduced motion the way the operating system's setting does. */
export async function emulateReducedMotion(): Promise<void> {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
}

/** Drops every emulated media feature, so the next test starts from the browser's own. */
export async function clearMediaEmulation(): Promise<void> {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
}
