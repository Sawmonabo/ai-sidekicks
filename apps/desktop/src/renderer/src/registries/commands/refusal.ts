// Where a command with no view of its own states a refusal, and where a command that ran and then
// failed is reported. Commands are contributed at composition time, so they cannot close over the
// window's banner; the mounted window publishes its banner sink here. A command's own failure
// draws fixed words, and its cause goes to the window's diagnostic capture, never the screen.

import type { Unsubscribe } from "#shared/preload-api.js";
import { RealClock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import { PublishedValue } from "#renderer/lib/published-value.js";
import { RefusalError, isRefusal, refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import { isErrorInstance, lossyStringify, readGuardedProperty } from "#renderer/lib/wire/errors.js";

/** The line a command that ran and failed draws, wherever it ran from. */
export const COMMAND_FAILED_DETAIL = "Couldn't run command";

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
 * Records a command's own failure in the window's diagnostic capture, under the origin of the
 * place it ran from and the command's id. Reads the failure guardedly and cannot throw, so the
 * failure being reported is never hidden by a second one.
 */
export function recordCommandFailure(origin: string, commandId: string, failure: unknown): void {
  const thrownMessage = readGuardedProperty(failure, "message");
  windowDiagnosticCapture.record({
    at: diagnosticStampAt(new RealClock()),
    severity: "error",
    source: origin,
    kind: "command-failed",
    detail: `${commandId}: ${
      isErrorInstance(failure) && typeof thrownMessage === "string"
        ? thrownMessage
        : lossyStringify(failure)
    }`,
  });
}

/**
 * Waits on a command that ran from the palette or a chord and states its failure, if it fails: a
 * refusal it threw as it was, anything else as the fixed failed line with its cause captured. A
 * failure while no window draws refusals is captured instead, never thrown from the handler.
 */
export function reportCommandFailure(commandId: string, completion: Promise<void>): void {
  completion.catch((failure: unknown) => {
    const thrownRefusal =
      failure instanceof RefusalError ? failure.refusal : isRefusal(failure) ? failure : undefined;
    const sink = commandRefusals.current;
    if (thrownRefusal === undefined || sink === undefined) {
      recordCommandFailure(COMMAND_REFUSAL_ORIGIN, commandId, failure);
    }
    sink?.(
      thrownRefusal ?? refuse(COMMAND_REFUSAL_ORIGIN, "command-failed", COMMAND_FAILED_DETAIL),
    );
  });
}

/** The origin a command's own failure carries. */
const COMMAND_REFUSAL_ORIGIN = "commands";

const commandRefusals = new PublishedValue<(refusal: Refusal) => void>();
