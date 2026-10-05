// The Claude leg of the output-speed axis: the level a process is told with
// `apply_flag_settings {fastMode}`, after every spawn and before a run that changes it. A level the
// driver's table does not list runs at standard, and a refusal leaves the process on the level it
// held; either way the declared state, not the request, says what the process runs at.

import type { SessionId } from "@ai-sidekicks/contracts/session/session";
import type { DriverDiagnosticsEmitter } from "../diagnostics.js";
import { CLAUDE_DRIVER_NAME } from "./capabilities.js";
import {
  CLAUDE_FAST_OUTPUT_SPEED,
  CLAUDE_STANDARD_OUTPUT_SPEED,
} from "./claude-driver-descriptor.js";
import type { ClaudeProviderProcess } from "./session/transport.js";

/** The level a carried `level` runs at: itself where the driver's table lists it, else standard. */
export function resolveClaudeOutputSpeed(level: string): string {
  return level === CLAUDE_FAST_OUTPUT_SPEED
    ? CLAUDE_FAST_OUTPUT_SPEED
    : CLAUDE_STANDARD_OUTPUT_SPEED;
}

/**
 * Tells the process to run at `level` (see {@link resolveClaudeOutputSpeed}) from its next run.
 * Answers the level the process now runs at, or `undefined` when the provider refused, which
 * leaves it on what it held and is recorded as a diagnostic. A transport failure throws.
 */
export async function applyClaudeOutputSpeed(
  channel: ClaudeProviderProcess,
  sessionId: SessionId,
  level: string,
  diagnostics: DriverDiagnosticsEmitter,
): Promise<string | undefined> {
  const applied = resolveClaudeOutputSpeed(level);
  const response = await channel.sendControlRequest({
    subtype: "apply_flag_settings",
    settings: { fastMode: applied === CLAUDE_FAST_OUTPUT_SPEED },
  });
  if (response.subtype !== "error") {
    return applied;
  }
  diagnostics.emit({
    provider: CLAUDE_DRIVER_NAME,
    kind: "output_speed_apply_refused",
    rawWireType: null,
    dispositionReason:
      "the provider refused the output-speed level; the process keeps the level it held and " +
      "the run's declared state reports it",
    // The level is the driver's own word; the provider's error text is untrusted and stays out.
    details: { sessionId, refusedLevel: applied },
  });
  return undefined;
}
