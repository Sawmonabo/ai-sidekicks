// The platform the renderer runs on, read once, and each platform's keyboard. The host is read
// here alone, so a test can hand any platform to the printer and the audit instead.

import type { SupportedPlatform } from "#shared/app-facts.js";
import type { KeyboardConvention } from "./contract.js";
import { DARWIN_KEYBOARD_CONVENTION } from "./darwin.js";
import { LINUX_KEYBOARD_CONVENTION } from "./linux.js";
import { WINDOWS_KEYBOARD_CONVENTION } from "./windows.js";

/**
 * The platform the app is running on, read once at module load (the renderer has no `process`).
 * macOS is told by the test tinykeys resolves `$mod` with, so `$mod` names the same key here as
 * in its matcher; Windows is told from Linux by the user agent.
 */
export const HOST_CHORD_PLATFORM: SupportedPlatform = detectHostChordPlatform();

/** The keyboard of `platform`. */
export function keyboardConventionOf(platform: SupportedPlatform): KeyboardConvention {
  return KEYBOARD_CONVENTIONS[platform];
}

const KEYBOARD_CONVENTIONS: Readonly<Record<SupportedPlatform, KeyboardConvention>> = {
  darwin: DARWIN_KEYBOARD_CONVENTION,
  linux: LINUX_KEYBOARD_CONVENTION,
  win32: WINDOWS_KEYBOARD_CONVENTION,
};

function detectHostChordPlatform(): SupportedPlatform {
  if (typeof navigator !== "object") {
    return "linux";
  }
  if (/Mac|iPod|iPhone|iPad/.test(navigator.platform)) {
    return "darwin";
  }
  return /win/i.test(`${navigator.platform} ${navigator.userAgent}`) ? "win32" : "linux";
}
