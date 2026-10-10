// Where the run engine's inbound dispatch sends a run's live-only state, such as Codex's safety
// hold on a turn, to the subscribers of the run's state stream. Nothing here is stored.
import type { RunStateStreamEvent } from "@ai-sidekicks/contracts/run/control";

/**
 * The run state stream's live intake, registered through a `PortRegistration`. It never blocks
 * or throws back into the provider's stream; an event with no subscriber, or arriving before the
 * publisher is registered, is dropped, never stored.
 */
export interface RunStatePublisher {
  publish(event: RunStateStreamEvent): void;
}
