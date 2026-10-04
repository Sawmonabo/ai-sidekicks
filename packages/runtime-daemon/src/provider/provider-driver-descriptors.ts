// Every provider's descriptor, keyed by provider name: the one place shared code finds a
// provider's static facts, and the only file outside `drivers/` that imports from it.

import type { ProviderName } from "@ai-sidekicks/contracts/provider-account";

import { CLAUDE_DRIVER_DESCRIPTOR } from "./drivers/claude/claude-driver-descriptor.js";
import { CODEX_DRIVER_DESCRIPTOR } from "./drivers/codex/codex-driver-descriptor.js";
import type { ProviderDriverDescriptor } from "./provider-driver-descriptor.js";

/** Each provider's static facts; total over `ProviderName`, so a new provider must declare one. */
export const PROVIDER_DRIVER_DESCRIPTORS: Readonly<Record<ProviderName, ProviderDriverDescriptor>> =
  Object.freeze({
    claude: CLAUDE_DRIVER_DESCRIPTOR,
    codex: CODEX_DRIVER_DESCRIPTOR,
  } satisfies Record<ProviderName, ProviderDriverDescriptor>);
