// Main's report of the console theme's terminal colors to the background service, which answers a
// program asking its terminal for colors from them until a pane holding the shell reports its own.
// Sent once a link is up and again at every change of theme or of the scheme in force; a link that
// comes back is a new client and is told again. A report that fails is logged, and the next change
// or link sends again.

import { PTY_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/pty";
import type { JsonRpcClient } from "@ai-sidekicks/client-sdk";

import type { ColorScheme } from "#shared/color-scheme.js";
import { describeFailure } from "#shared/failure-message.js";
import type { AppearanceTheme } from "#shared/theme/registry.js";
import { composeTerminalColors } from "#shared/theme/terminal-colors.js";

import type { MainDiagnosticLog } from "../services/diagnostic-log.js";
import type { DaemonLink } from "../services/daemon/link/status.js";
import type { KeptAppearance } from "./kept-record.js";

const LOG_SOURCE = "main/appearance";

/** What the report reads and where it logs a failure. */
export interface ConsoleThemeReportOptions {
  readonly link: Pick<DaemonLink, "client" | "state" | "subscribe">;
  readonly appearance: Pick<KeptAppearance, "record" | "resolvedScheme" | "subscribe">;
  readonly log: Pick<MainDiagnosticLog, "write">;
}

/** The colors last sent, and the link they were sent on. */
interface SentReport {
  readonly client: JsonRpcClient;
  readonly theme: AppearanceTheme;
  readonly scheme: ColorScheme;
}

/** Keeps the background service told the console theme's terminal colors. */
export class ConsoleThemeReport {
  readonly #options: ConsoleThemeReportOptions;
  #sent: SentReport | undefined;

  public constructor(options: ConsoleThemeReportOptions) {
    this.#options = options;
  }

  /** Reports now when a link is up, then at every new link and every change of appearance. */
  public start(): void {
    this.#options.link.subscribe(() => {
      this.#report();
    });
    this.#options.appearance.subscribe(() => {
      this.#report();
    });
  }

  #report(): void {
    const { link, appearance, log } = this.#options;
    const client = link.client;
    if (client === undefined || link.state.connection.kind !== "connected") {
      return;
    }
    const theme = appearance.record.theme;
    const scheme = appearance.resolvedScheme;
    const last = this.#sent;
    if (last?.client === client && last.theme === theme && last.scheme === scheme) {
      return;
    }
    const sent: SentReport = { client, theme, scheme };
    this.#sent = sent;
    const descriptor = PTY_METHOD_DESCRIPTORS["pty.reportTerminalAppearance"];
    client
      .call(
        descriptor.method,
        { source: "console_theme", colors: composeTerminalColors(theme, scheme) },
        descriptor.requestSchema,
        descriptor.responseSchema,
      )
      .catch((failure: unknown) => {
        if (this.#sent === sent) {
          this.#sent = undefined;
        }
        log.write({
          level: "warning",
          source: LOG_SOURCE,
          message:
            "The background service did not take the console theme's terminal colors: " +
            describeFailure(failure),
        });
      });
  }
}
