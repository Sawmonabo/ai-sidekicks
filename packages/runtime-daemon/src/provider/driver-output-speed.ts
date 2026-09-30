/**
 * The per-driver output-speed value vocabularies, read by both the live capability
 * declaration and `DriverCapabilitiesWriter.hydrate()`.
 *
 * - The cold-start hydrate path has no driver instance, yet `outputSpeedLevels` must be present
 *   whenever `capabilities.flags.output_speed` is `true` on either read path, so both paths read
 *   this one table.
 * - No cache column holds it: it is a constant of the driver, always re-derivable, and a stored
 *   copy could publish a vocabulary this build no longer declares.
 * - An entry lists what a caller may request. A provider can report more states (a rate-limit
 *   cooldown it enters on its own); `ProviderOutputSpeedState.declared` carries those verbatim.
 * - The table is total over `FlooredDriverName`, and an empty entry is a declaration, not an
 *   omission: an omitted driver is a wiring fault the lookup throws on, while an empty list is the
 *   complete declaration a `false` flag implies.
 */

import type { FlooredDriverName } from "./capability-refresh.js";

/**
 * The declared, settable output-speed levels per driver.
 *
 * Deep-frozen because the arrays are shared by every reader; publishers hand out copies,
 * and the freeze makes a missed copy throw instead of corrupting later reports.
 */
export const DRIVER_OUTPUT_SPEED_LEVELS: Readonly<Record<FlooredDriverName, readonly string[]>> =
  Object.freeze({
    // The pinned Claude build declares its state from a three-value vocabulary; only these two
    // are requestable, the third is entered by the provider after a rate limit.
    claude: Object.freeze(["off", "on"]),
    // Empty on purpose: this provider declares no settable output-speed levels (its per-turn
    // `serviceTier` override has no enumerated level set), so a caller carrying an `outputSpeed`
    // is refused rather than forwarding an unvalidated value.
    codex: Object.freeze([]),
  });

/**
 * Resolve a driver's declared output-speed vocabulary by registry key.
 *
 * Throws for a name the table does not carry: callers arrive here only after reading
 * `output_speed: true`, so an unknown name is a driver registered without an entry or a cache row
 * written out of band, and either would publish a result that breaks its own required-when rule.
 * `Object.hasOwn` keeps an inherited key such as `constructor` from resolving to a function.
 */
export function declaredOutputSpeedLevelsFor(driverName: string): readonly string[] {
  if (!Object.hasOwn(DRIVER_OUTPUT_SPEED_LEVELS, driverName)) {
    throw new Error(
      `declaredOutputSpeedLevelsFor: no output-speed vocabulary is declared for driver '${driverName}'`,
    );
  }
  return DRIVER_OUTPUT_SPEED_LEVELS[driverName as FlooredDriverName];
}
