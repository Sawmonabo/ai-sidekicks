// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Why a run needs recovery: the axis a resume failure and a run's state change carry.

/** Every recovery condition. */
export const RECOVERY_CONDITIONS = ["recoveryNeeded", "reauthRequired"] as const;

/**
 * Why a run needs attention.
 */
export type RecoveryCondition = "recoveryNeeded" | "reauthRequired";

export { validateRecoveryCondition } from "../../checks/provider/driver/recovery.js";
