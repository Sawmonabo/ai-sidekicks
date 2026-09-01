/**
 * The per-driver output-speed value vocabularies — the ONE table every reader
 * of that axis reads (Plan-005 T3.26, `Spec-005 §The output-speed axis`).
 *
 * WHY THIS IS A PROVIDER-LEVEL MODULE AND NOT A PAIR OF DRIVER CONSTANTS. The
 * vocabulary has TWO readers, and only one of them holds a driver. The live
 * declaration each driver's `getCapabilities()` composes is the obvious one;
 * the other is `DriverCapabilitiesWriter.hydrate()`, which reconstructs a whole
 * `GetCapabilitiesResult` from the durable cache at cold start with no driver
 * instance in hand at all. The contract requires `outputSpeedLevels` present
 * whenever `capabilities.flags.output_speed` is `true` "on either read path",
 * so the cache reader needs exactly the values the driver reader publishes.
 *
 * WHY NO CACHE COLUMN. `GetCapabilitiesResult`'s own reasoning settles it: this
 * is a constant OF THE DRIVER and therefore always re-derivable, unlike
 * `detectionSource`, which is a fact about ONE READING and legitimately absent
 * on the hydrate path. Persisting a vocabulary would mint a column whose only
 * content is a value the running build already knows, and would let a stale row
 * publish a vocabulary this build no longer declares.
 *
 * SETTABLE is the operative word, and it is why an entry can be narrower than
 * the states its provider can REPORT. A provider may declare a state a
 * participant may not ask for — a rate-limit cooldown the build enters on its
 * own is the shipped example — and `ProviderOutputSpeedState.declared` carries
 * whatever the provider reported VERBATIM, including a value absent from these
 * lists, because that is a real state under version skew and coercing it would
 * fabricate a reading. This table bounds what a caller may REQUEST; it never
 * bounds what a provider may say.
 *
 * TOTAL over `FlooredDriverName` by type annotation, and the empty Codex entry
 * is a DECLARATION rather than an omission — the same doctrine
 * `PROVIDER_AUTO_UPDATE_OPT_OUT_ENV` records. An omitted key and a
 * deliberately-empty one must never look alike, and here they would not even
 * fail alike: an omitted key is a wiring fault this module throws on, while an
 * empty entry is the complete declaration a `false` flag implies.
 */

import type { FlooredDriverName } from "./capability-refresh.js";

/**
 * The declared, settable output-speed levels per driver.
 *
 * Deep-frozen: the arrays are shared by every reader on both read paths, so a
 * consumer that pushed onto one would rewrite every later report process-wide.
 * Publishers hand out COPIES; the freeze is what makes a missed copy throw
 * instead of corrupt.
 */
export const DRIVER_OUTPUT_SPEED_LEVELS: Readonly<Record<FlooredDriverName, readonly string[]>> =
  Object.freeze({
    // The pinned Claude build declares its state from a three-value vocabulary,
    // of which only these two are requestable — the third is a provider-entered
    // condition after a rate limit rather than something a participant may ask
    // for.
    claude: Object.freeze(["off", "on"]),
    // EMPTY, and that is the complete declaration the `output_speed: false` flag
    // implies: this provider declares no settable output-speed level vocabulary
    // anywhere (its per-turn `serviceTier` override carries no enumerated level
    // set and no declared-state read), so `Spec-005 §The output-speed axis`
    // makes an absent or empty vocabulary the signal that the axis is
    // unsettable and a caller carrying an `outputSpeed` refuses fail-closed
    // rather than forwarding an unvalidated value.
    codex: Object.freeze([]),
  });

/**
 * Resolve a driver's declared output-speed vocabulary by registry key.
 *
 * THROWS for a name this table does not carry. A caller reaches this function
 * only after reading `output_speed: true` for that driver — from a live
 * declaration or from the durable cache — so an unknown name means either a
 * driver was registered without an entry here or a cache row was written
 * out-of-band. Both are daemon wiring faults rather than provider misbehaviour,
 * and both would otherwise publish a `GetCapabilitiesResult` that violates its
 * own required-when-`output_speed` rule while looking well-formed. Loud is the
 * same discipline the writer's row-set-invariant guard takes.
 *
 * `Object.hasOwn` rather than a bare index read: a bare read would resolve
 * inherited `Object.prototype` keys, so a driver named `constructor` would
 * silently return a function instead of failing.
 */
export function declaredOutputSpeedLevelsFor(driverName: string): readonly string[] {
  if (!Object.hasOwn(DRIVER_OUTPUT_SPEED_LEVELS, driverName)) {
    throw new Error(
      `declaredOutputSpeedLevelsFor: no output-speed vocabulary is declared for driver '${driverName}'`,
    );
  }
  return DRIVER_OUTPUT_SPEED_LEVELS[driverName as FlooredDriverName];
}
