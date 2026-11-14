// Where a command with no view of its own states a refusal, and where a command that ran and then
// failed is reported. Commands are contributed at composition time, so they cannot close over the
// window's banner; the mounted window publishes its banner sink here.

import { describeFailure } from "#shared/failure-message.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { PublishedValue } from "#renderer/lib/published-value.js";
import { RefusalError, isRefusal, refuse, type Refusal } from "#renderer/lib/refusal/contract.js";

/** Publishes this window's refusal rendering; only the window calls it. */
export function publishCommandRefusalSink(sink: (refusal: Refusal) => void): Unsubscribe {
  return commandRefusals.publish(sink);
}

/**
 * States a refusal from a command with no view of its own. Throws the refusal as a
 * `RefusalError` when no window has published a sink, since a command runs only in a mounted
 * window and a refusal nobody draws must not vanish.
 */
export function raiseCommandRefusal(refusal: Refusal): void {
  const sink = commandRefusals.current;
  if (sink === undefined) {
    throw new RefusalError(refusal);
  }
  sink(refusal);
}

/**
 * Waits on a command that ran from the palette or a chord and states its failure, if it fails: a
 * refusal it threw as it was, anything else as the command not completing.
 */
export function reportCommandFailure(commandId: string, completion: Promise<void>): void {
  completion.catch((failure: unknown) => {
    raiseCommandRefusal(
      failure instanceof RefusalError
        ? failure.refusal
        : isRefusal(failure)
          ? failure
          : refuse(
              COMMAND_REFUSAL_ORIGIN,
              "command-failed",
              `${commandId} did not complete: ${describeFailure(failure)}`,
            ),
    );
  });
}

/** The origin a command's own failure carries. */
const COMMAND_REFUSAL_ORIGIN = "commands";

const commandRefusals = new PublishedValue<(refusal: Refusal) => void>();
