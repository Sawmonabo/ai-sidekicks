// Where the run engine's inbound dispatch sends a run's live-only state, Codex's safety hold on a
// turn, to the subscribers of the run's session state stream. Nothing here is stored.
import type { RunSafetyBufferingUpdatedPayload } from "@ai-sidekicks/contracts/session/controls/events";

/**
 * The run state stream's live intake, registered through a `PortRegistration`. It never blocks
 * or throws back into the provider's stream; a hold with no subscriber, or arriving before the
 * publisher is registered, is dropped, never stored.
 */
export interface RunStatePublisher {
  publish(hold: RunSafetyBufferingUpdatedPayload): void;
}
