// Every provider's descriptor, keyed by provider name: the one place shared code finds a
// provider's static facts, and the only file outside `drivers/` that imports from it.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/account/account";
import type { DriverCapabilityFlag } from "@ai-sidekicks/contracts/provider/driver/driver";

import { CLAUDE_DRIVER_DESCRIPTOR } from "./drivers/claude/claude-driver-descriptor.js";
import { CODEX_DRIVER_DESCRIPTOR } from "./drivers/codex/codex-driver-descriptor.js";
import type { ProviderDriverDescriptor } from "./provider-driver-descriptor.js";

/** Each provider's static facts; total over `ProviderName`, so a new provider must declare one. */
export const PROVIDER_DRIVER_DESCRIPTORS: Readonly<Record<ProviderName, ProviderDriverDescriptor>> =
  Object.freeze({
    claude: CLAUDE_DRIVER_DESCRIPTOR,
    codex: CODEX_DRIVER_DESCRIPTOR,
  } satisfies Record<ProviderName, ProviderDriverDescriptor>);

/**
 * The `outputSpeedLevels` member a capability report carries for `driverName`: a fresh copy of the
 * driver's static set where `output_speed` resolved true, else nothing, because an empty list
 * would claim a settable axis with no values. A driver whose provider publishes its levels per
 * model declares no static set, so its report carries none.
 */
export function composeStaticOutputSpeedLevels(
  driverName: ProviderName,
  flags: Readonly<Record<DriverCapabilityFlag, boolean>>,
): { outputSpeedLevels?: string[] } {
  const levels = PROVIDER_DRIVER_DESCRIPTORS[driverName].outputSpeedLevels;
  return flags.output_speed && levels !== undefined ? { outputSpeedLevels: [...levels] } : {};
}
