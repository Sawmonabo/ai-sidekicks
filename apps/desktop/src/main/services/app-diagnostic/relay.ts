// Main's relay of what the app records about itself to the service's diagnostic log: every error
// nothing handled, a window's and main's own, and every line a window's diagnostic capture took.
// Each is redacted and bounded (`record.ts`) and counted against the rate before it goes, and an
// error of main's own is also written to main's log, which keeps it when the service never hears
// of it. While no link to the service is up, the first thirty-two records wait and are sent, in
// order, when one comes up; past them a count is kept and sent as one record once a link is up
// again. A record the service did not take is never sent again but counted, and the count goes
// with the next record it takes, so an outage costs one call per record and never loops, and
// main's own log says once per outage that the service is not taking them.

import {
  APP_DIAGNOSTIC_TEXT_BOUNDS,
  DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS,
  type AppDiagnosticHeldBackCause,
  type AppDiagnosticRecord,
  type AppErrorThrown,
  type AppCapturedDiagnostic,
} from "@ai-sidekicks/contracts/daemon/app-diagnostic";
import type { JsonRpcClient } from "@ai-sidekicks/client-sdk";

import { describeFailure } from "#shared/failure-message.js";
import { DiagnosticRateLimit, fingerprintOf } from "#shared/app-diagnostic/rate-limit.js";
import { bounded } from "#shared/app-diagnostic/redaction.js";
import {
  readThrownValue,
  recordCountOf,
  type WindowDiagnosticReport,
} from "#shared/app-diagnostic/report.js";

import type { DaemonLink } from "../daemon/link/status.js";
import type { MainDiagnosticLog } from "../diagnostic-log.js";
import { boundAppError, boundCapturedDiagnostic } from "./record.js";

// The module main's log names for what the relay writes.
const LOG_SOURCE = "main/app-diagnostic";

/** How many records wait for the service while no link is up; past them, each is counted. */
export const APP_DIAGNOSTIC_RECORDS_HELD_WHILE_UNREACHABLE = 32;

/** What the relay sends over and where it says the service is not taking records. */
export interface AppDiagnosticRelayOptions {
  readonly link: Pick<DaemonLink, "client" | "state" | "subscribe">;
  readonly log: Pick<MainDiagnosticLog, "write">;
  /** The clock each record main makes is stamped from. */
  readonly now: () => Date;
}

/** Carries what the app records about itself to the service's diagnostic log; never throws. */
export class AppDiagnosticRelay {
  readonly #options: AppDiagnosticRelayOptions;
  readonly #limit: DiagnosticRateLimit;
  readonly #held: AppDiagnosticRecord[] = [];
  /** Records the relay could not hold while no link was up, since the last count sent. */
  #unheldCount = 0;
  /** Records the service did not take, since the last count sent. */
  #refusedCount = 0;
  #isRefusalLogged = false;

  /** Sends what waits each time a link comes up, from now on. */
  public constructor(options: AppDiagnosticRelayOptions) {
    this.#options = options;
    this.#limit = new DiagnosticRateLimit(
      (count) => {
        this.#send(this.#heldBack(count, "past-rate"));
      },
      // Unreferenced, so a count still waiting never keeps main from quitting.
      (end, ms) => {
        setTimeout(end, ms).unref();
      },
    );
    options.link.subscribe(() => {
      this.#sendWaiting();
    });
  }

  /** A window's reports, already parsed at the bridge. */
  public reportFromWindow(reports: readonly WindowDiagnosticReport[]): void {
    for (const report of reports) {
      switch (report.kind) {
        case "held-back":
          // Held back here too, the count still stands for every record the window held back.
          if (this.#limit.admit(fingerprintOf(report), report.count)) {
            this.#send(this.#heldBack(report.count, report.cause));
          }
          break;
        case "captured":
          this.#reportLimited(boundCapturedDiagnostic(report.record));
          break;
        default:
          this.#reportLimited(boundAppError(report, this.#options.now()));
      }
    }
  }

  /** An uncaught exception or unhandled rejection of main's own. */
  public reportFromMain(value: unknown, kind: AppErrorThrown["kind"]): void {
    const parts = readThrownValue(value, kind);
    const record = boundAppError(
      { kind, role: "main", ...parts, source: null },
      this.#options.now(),
    );
    if (this.#reportLimited(record)) {
      const heading = [kind, record.name, record.message]
        .filter((part) => part !== null)
        .join(": ");
      this.#options.log.write({
        level: "error",
        source: LOG_SOURCE,
        message: record.stack === null ? heading : `${heading}\n${record.stack}`,
      });
    }
  }

  /** The process drawing every window went away, for `reason` with `exitCode`. */
  public reportRendererGone(reason: string, exitCode: number): void {
    this.#send({
      kind: "renderer-gone",
      at: this.#options.now().toISOString(),
      reason: bounded(reason, APP_DIAGNOSTIC_TEXT_BOUNDS.reason),
      exitCode,
    });
  }

  // Whether the record went on under the rate.
  #reportLimited(record: AppErrorThrown | AppCapturedDiagnostic): boolean {
    const isAdmitted = this.#limit.admit(fingerprintOf(record));
    if (isAdmitted) {
      this.#send(record);
    }
    return isAdmitted;
  }

  #send(record: AppDiagnosticRecord): void {
    const client = this.#connectedClient();
    if (client === undefined) {
      if (this.#held.length < APP_DIAGNOSTIC_RECORDS_HELD_WHILE_UNREACHABLE) {
        this.#held.push(record);
      } else {
        this.#unheldCount += recordCountOf(record);
      }
      return;
    }
    const descriptor = DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS["daemon.appDiagnostic.record"];
    client
      .call(descriptor.method, record, descriptor.requestSchema, descriptor.responseSchema)
      .then(
        () => {
          this.#isRefusalLogged = false;
          if (this.#refusedCount > 0) {
            const count = this.#refusedCount;
            this.#refusedCount = 0;
            this.#send(this.#heldBack(count, "service-refused"));
          }
        },
        (failure: unknown) => {
          this.#refusedCount += recordCountOf(record);
          if (!this.#isRefusalLogged) {
            this.#isRefusalLogged = true;
            this.#options.log.write({
              level: "warning",
              source: LOG_SOURCE,
              message:
                "The background service did not take an app diagnostic, so the ones it does not " +
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
    if (this.#unheldCount > 0) {
      const count = this.#unheldCount;
      this.#unheldCount = 0;
      this.#send(this.#heldBack(count, "service-unreachable"));
    }
  }

  #connectedClient(): JsonRpcClient | undefined {
    const { link } = this.#options;
    return link.state.connection.kind === "connected" ? link.client : undefined;
  }

  #heldBack(count: number, cause: AppDiagnosticHeldBackCause): AppDiagnosticRecord {
    return { kind: "held-back", at: this.#options.now().toISOString(), count, cause };
  }
}
