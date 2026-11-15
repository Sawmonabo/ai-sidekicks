// Where a command with no view of its own states a refusal, and where a command that ran and then
// failed is reported. Commands are contributed at composition time, so they cannot close over the
// window's banner; the mounted window publishes its banner sink here. A command's own failure
// reads its name; a refusal it threw lends its code's words as the cause, never the service's
// sentence, which can name an id, and any other cause goes to the window's diagnostic capture,
// never the screen.

import type { Unsubscribe } from "#shared/preload-api.js";
import { RealClock } from "#renderer/lib/clock.js";
import { refusalCause } from "#renderer/lib/code-words.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import { PublishedValue } from "#renderer/lib/published-value.js";
import { RefusalError, isRefusal, refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { isErrorInstance, lossyStringify, readGuardedProperty } from "#renderer/lib/wire/errors.js";
import type { CommandDefinition } from "./definition.js";

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
 * The line a command that ran and failed draws: `Couldn't` and its name with the first letter
 * lower-cased (`Couldn't stop run`), or `<Name> failed` for a name that is no verb phrase
 * (`Undo failed`), then ` · <cause>` where the failure carries words for the person. The name is
 * the title without its subject, so the line carries no second subject and no id.
 */
export function commandFailedLine(
  command: Pick<CommandDefinition, "title" | "name" | "isTitleVerbPhrase">,
  cause: string | undefined,
): string {
  const name = command.name ?? command.title;
  const head =
    command.isTitleVerbPhrase === false
      ? `${name} failed`
      : `Couldn't ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
  return cause === undefined ? head : `${head} · ${cause}`;
}

/**
 * States a command's own failure on the window's banner, wherever it ran from, under `origin`. A
 * refusal it threw gives the line its cause, in its code's words; any other failure, and any
 * failure while no window draws refusals, goes to the diagnostic capture. Reads the failure
 * guardedly and cannot throw.
 */
export function stateCommandFailure(
  origin: string,
  command: Pick<CommandDefinition, "id" | "title" | "name" | "isTitleVerbPhrase">,
  failure: unknown,
): void {
  const thrownRefusal: ExtendedRefusal | undefined =
    failure instanceof RefusalError ? failure.refusal : isRefusal(failure) ? failure : undefined;
  const sink = commandRefusals.current;
  if (thrownRefusal === undefined || sink === undefined) {
    recordCommandFailure(origin, command.id, failure);
  }
  const cause =
    thrownRefusal === undefined
      ? undefined
      : refusalCause(thrownRefusal.code, thrownRefusal.reason, thrownRefusal.detail);
  sink?.(refuse(origin, "command-failed", commandFailedLine(command, cause)));
}

/**
 * Waits on a command that ran from the palette or a chord and states its failure, if it fails. A
 * failure is never thrown from the handler.
 */
export function reportCommandFailure(
  command: Pick<CommandDefinition, "id" | "title" | "name" | "isTitleVerbPhrase">,
  completion: Promise<void>,
): void {
  completion.catch((failure: unknown) => {
    stateCommandFailure(COMMAND_REFUSAL_ORIGIN, command, failure);
  });
}

/** The origin a command's own failure carries. */
const COMMAND_REFUSAL_ORIGIN = "commands";

const commandRefusals = new PublishedValue<(refusal: Refusal) => void>();

/** Records a command's own failure in the window's diagnostic capture, under its origin and id. */
function recordCommandFailure(origin: string, commandId: string, failure: unknown): void {
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
