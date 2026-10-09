// Where a driver sends a running command's output as it prints, to the subscribers of the
// session's running-commands stream. Nothing here is stored: the command's whole output lands as
// its tool call's result.
import type { CommandListFrame } from "@ai-sidekicks/contracts/command";

/**
 * The running-commands stream's live output intake, registered through a `PortRegistration`. It
 * never blocks or throws back into the provider's stream; output with no subscriber, or arriving
 * before the publisher is registered, is dropped, never stored.
 */
export interface CommandOutputPublisher {
  publish(frame: Extract<CommandListFrame, { kind: "output" }>): void;
}
