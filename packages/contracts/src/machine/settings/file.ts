// Reading the machine's settings file as the service reads it: what the file holds laid over the
// defaults, then checked whole by the generated check.
import {
  MACHINE_SETTINGS_DEFAULTS,
  validateMachineSettings,
  type MachineSettings,
} from "../../generated/machine/settings.js";

/**
 * The file's parsed JSON as settings: a key the file lacks takes its default, and an unknown key or
 * a value out of shape refuses the whole file, answered as `null`, which the service reads as the
 * defaults and repairs.
 */
export function parseMachineSettingsFile(fileJson: unknown): MachineSettings | null {
  const settings = laidOverDefaults(MACHINE_SETTINGS_DEFAULTS, fileJson);
  return validateMachineSettings(settings) ? settings : null;
}

/**
 * `stored` laid over `defaults` member by member and group by group; a key the defaults lack is
 * kept, so the check refuses it. A file that is not an object is answered as it is.
 */
function laidOverDefaults(defaults: unknown, stored: unknown): unknown {
  if (!isJsonObject(stored)) {
    return stored;
  }
  const laid: Record<string, unknown> = isJsonObject(defaults) ? { ...defaults } : {};
  for (const [key, storedValue] of Object.entries(stored)) {
    const defaultValue = Object.hasOwn(laid, key) ? laid[key] : undefined;
    // Defined, not assigned, so a stored `__proto__` stays a key the check refuses.
    Object.defineProperty(laid, key, {
      value:
        isJsonObject(defaultValue) && isJsonObject(storedValue)
          ? laidOverDefaults(defaultValue, storedValue)
          : storedValue,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return laid;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
