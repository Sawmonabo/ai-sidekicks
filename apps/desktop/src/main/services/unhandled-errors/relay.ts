// Main's relay of every error nothing handled, a window's and main's own, to the service's
// diagnostic log. Each is bounded and stripped (`record.ts`) and counted against the rate
// (`repeat-limit.ts`) before it goes. While no link to the service is up, the first thirty-two
// records wait and are sent, in order, when one comes up; past them, and for every record the
// service did not take, a count is kept and sent as one record once a link is up again. A record
// the service did not take is never sent again, so an outage costs one call per record and never
// loops, and main's own log says once per outage that the service is not taking them.

import {
  APP_ERROR_TEXT_BOUNDS,
  DAEMON_APP_ERROR_METHOD_DESCRIPTORS,
  type AppErrorHeldBackCause,
  type AppErrorRecord,
  type AppErrorThrown,
} from "@ai-sidekicks/contracts/daemon/app-error";
import type { JsonRpcClient } from "@ai-sidekicks/client-sdk";

import { describeFailure } from "#shared/failure-message.js";
import { readThrownValue, type UnhandledErrorReport } from "#shared/unhandled-error.js";

import type { DaemonLink } from "../daemon/link/status.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import { boundAppError, fingerprintOf } from "./record.js";
import { RepeatLimit } from "./repeat-limit.js";

/** How many records wait for the service while no link is up; past them, each is counted. */
export const UNHANDLED_ERRORS_HELD_WHILE_UNREACHABLE = 32;

/** What the relay sends over and where it says the service is not taking records. */
export interface UnhandledErrorRelayOptions {
  readonly link: Pick<DaemonLink, "client" | "state" | "subscribe">;
  readonly log: Pick<MainDiagnosticLog, "write">;
  /** The clock each record is stamped from. */
  readonly now: () => Date;
}

/** Carries each unhandled error to the service's diagnostic log; never throws at its caller. */
export class UnhandledErrorRelay {
  readonly #options: UnhandledErrorRelayOptions;
  readonly #limit: RepeatLimit;
  readonly #held: AppErrorRecord[] = [];
  /** Records the service did not take or the relay could not hold, since the last count sent. */
  #unsentCount = 0;
  #isRefusalLogged = false;

  /** Sends what waits each time a link comes up, from now on. */
  public constructor(options: UnhandledErrorRelayOptions) {
    this.#options = options;
    this.#limit = new RepeatLimit((count) => {
      this.#send(this.#heldBack(count, "repeated"));
    });
    options.link.subscribe(() => {
      this.#sendWaiting();
    });
  }

  /** A window's report, already parsed at the bridge. */
  public reportFromWindow(report: UnhandledErrorReport): void {
    if (report.kind === "held-back") {
      if (this.#limit.admit(JSON.stringify([report.kind, report.role]))) {
        this.#send(this.#heldBack(report.count, "window-not-ready"));
      }
      return;
    }
    this.#reportThrown(boundAppError(report, this.#options.now()));
  }

  /** An uncaught exception or unhandled rejection of main's own. */
  public reportFromMain(value: unknown, kind: AppErrorThrown["kind"]): void {
    const parts = readThrownValue(value, kind);
    this.#reportThrown(
      boundAppError({ kind, role: "main", ...parts, source: null }, this.#options.now()),
    );
  }

  /** The process drawing every window went away, for `reason` with `exitCode`. */
  public reportRendererGone(reason: string, exitCode: number): void {
    this.#send({
      kind: "renderer-gone",
      at: this.#options.now().toISOString(),
      reason: reason.slice(0, APP_ERROR_TEXT_BOUNDS.reason),
      exitCode,
    });
  }

  #reportThrown(record: AppErrorThrown): void {
    if (this.#limit.admit(fingerprintOf(record))) {
      this.#send(record);
    }
  }

  #send(record: AppErrorRecord): void {
    const client = this.#connectedClient();
    if (client === undefined) {
      if (this.#held.length < UNHANDLED_ERRORS_HELD_WHILE_UNREACHABLE) {
        this.#held.push(record);
      } else {
        this.#unsentCount += unsentCountOf(record);
      }
      return;
    }
    const descriptor = DAEMON_APP_ERROR_METHOD_DESCRIPTORS["daemon.appError.record"];
    client
      .call(descriptor.method, record, descriptor.requestSchema, descriptor.responseSchema)
      .then(
        () => {
          this.#isRefusalLogged = false;
        },
        (failure: unknown) => {
          this.#unsentCount += unsentCountOf(record);
          if (!this.#isRefusalLogged) {
            this.#isRefusalLogged = true;
            this.#options.log.write({
              level: "warning",
              source: "main/unhandled-errors",
              message:
                "The background service did not take an app error, so the ones it does not " +
                `take are counted until it does: ${describeFailure(failure)}`,
            });
          }
        },
      );
  }

  #sendWaiting(): void {
    if (this.#connectedClient() === undefined) {
      return;
    }
    for (const record of this.#held.splice(0)) {
      this.#send(record);
    }
    if (this.#unsentCount > 0) {
      const count = this.#unsentCount;
      this.#unsentCount = 0;
      this.#send(this.#heldBack(count, "service-unreachable"));
    }
  }

  #connectedClient(): JsonRpcClient | undefined {
    const { link } = this.#options;
    return link.state.connection.kind === "connected" ? link.client : undefined;
  }

  #heldBack(count: number, cause: AppErrorHeldBackCause): AppErrorRecord {
    return { kind: "held-back", at: this.#options.now().toISOString(), count, cause };
  }
}

// A count of unsent records that is itself unsent carries them all, so none is lost from it.
function unsentCountOf(record: AppErrorRecord): number {
  return record.kind === "held-back" && record.cause === "service-unreachable" ? record.count : 1;
}
