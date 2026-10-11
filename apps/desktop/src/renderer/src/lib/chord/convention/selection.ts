// The keyboard of the operating system the renderer runs on, picked once. The host is read here
// alone, and every chord reader takes the picked keyboard as a parameter, so a test can hand any
// system's keyboard to the printer and the audit instead.

import type { SupportedPlatform } from "#shared/app-facts.js";
import type { KeyboardConvention } from "./contract.js";
import { LINUX_KEYBOARD_CONVENTION } from "./linux.js";
import { MAC_KEYBOARD_CONVENTION } from "./mac.js";
import { WINDOWS_KEYBOARD_CONVENTION } from "./windows.js";

/**
 * The keyboard of the system the app is running on, picked once at module load (the renderer has
 * no `process`). macOS is told by the test tinykeys resolves `$mod` with, so `$mod` names the same
 * key here as in its matcher; Windows is told from Linux by the user agent.
 */
export const HOST_KEYBOARD_CONVENTION: KeyboardConvention =
  selectKeyboardConvention(readHostPlatform());

function selectKeyboardConvention(platform: SupportedPlatform): KeyboardConvention {
  switch (platform) {
    case "darwin":
      return MAC_KEYBOARD_CONVENTION;
    case "linux":
      return LINUX_KEYBOARD_CONVENTION;
    case "win32":
      return WINDOWS_KEYBOARD_CONVENTION;
  }
}

function readHostPlatform(): SupportedPlatform {
  if (typeof navigator !== "object") {
    return "linux";
  }
  if (/Mac|iPod|iPhone|iPad/.test(navigator.platform)) {
    return "darwin";
  }
  return /win/i.test(`${navigator.platform} ${navigator.userAgent}`) ? "win32" : "linux";
}
