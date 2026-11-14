// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The daemon-assigned id of the one machine a daemon runs on.

/**
 * The opaque, daemon-minted id of one machine's daemon.
 */
export type MachineId = string & { readonly __brand: "MachineId" };

export { validateMachineId } from "../checks/machine/id.js";
