// How long a run took, or has taken so far, in the one duration style the workflows screen writes:
// `6 m 41 s`, `38 s`. The runs table and a run's header both read it.

import { parseInstant } from "@renderer/lib/instant.js";
import { formatUnitDuration } from "@renderer/lib/wire-figures.js";

/**
 * The span from `startedAt` to `untilMs`, in units; an unreadable start reads as nothing, since a
 * span from it would be invented.
 */
export function runDurationWords(startedAt: string, untilMs: number): string {
  const started = parseInstant(startedAt);
  return started.kind === "instant"
    ? formatUnitDuration(Math.max(0, untilMs - started.epochMilliseconds))
    : "";
}
