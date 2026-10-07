// The `sidekicks://` link handler. At every start an installed app takes the link scheme from
// whichever app held it; a development or test run takes nothing, so running one never moves the
// links away from the installed app. macOS hands a link to `open-url`, before ready when the link
// launched the app; Windows and Linux hand it on a command line, the first instance's at launch
// and a second launch's through `second-instance`, the one listener for a second launch: one
// carrying no link brings the window used last forward. A link is untrusted input from any program
// on the machine: the one parser reads it, a refused one routes nothing and is logged without its
// text, which may carry a secret, and a parsed one becomes a navigation request, which main's
// registry of windows hands the console document.

import type { App } from "electron";

import { APP_LINK_SCHEME, parseAppLink } from "@ai-sidekicks/contracts/app-link";

import type { NavigationRequest } from "#shared/preload-api.js";
import type { MainDiagnosticLog } from "./diagnostic-log.js";

/** What the link handler acts through. */
export interface AppLinkHandlerOptions {
  readonly app: Pick<
    App,
    | "on"
    | "isPackaged"
    | "setAsDefaultProtocolClient"
    | "isDefaultProtocolClient"
    | "getApplicationNameForProtocol"
  >;
  /**
   * Main's registry of windows, which hands each request to the console document and brings the
   * window used last forward for a second launch carrying no link.
   */
  readonly windows: {
    requestNavigation(request: NavigationRequest): void;
    showWindowUsedLast(): void;
  };
  readonly log: Pick<MainDiagnosticLog, "write">;
}

const LOG_SOURCE = "main/services/app-link";

// Matched without regard to case, as a URI scheme is, so a link the parser refuses for its case is
// still found, refused and logged rather than taken for a plain second launch.
const APP_LINK_ARGUMENT = new RegExp(`^${APP_LINK_SCHEME}:`, "iu");

/**
 * Routes every link that reaches this app, the one on this launch's own command line included,
 * and, in an installed app only, takes the `sidekicks://` links for it. Call it before ready: macOS
 * hands the link that launched the app to `open-url` before then.
 */
export function installAppLinkHandler(options: AppLinkHandlerOptions): void {
  const { app, windows, log } = options;
  const route = (address: string, arrival: string): void => {
    const request = parseAppLink(address);
    if (request === null) {
      // Never the address itself: it came from any program, and a query on it may hold a secret.
      log.write({
        level: "warning",
        source: LOG_SOURCE,
        message:
          `a ${APP_LINK_SCHEME}:// link from ${arrival} was refused: ` +
          "it is not a link to a session or a workflow run",
      });
      return;
    }
    windows.requestNavigation(request);
  };
  app.on("second-instance", (_event, commandLine) => {
    const address = findAppLinkArgument(commandLine);
    // A link's place is the console document's call, so no other window comes forward first.
    if (address === undefined) {
      windows.showWindowUsedLast();
    } else {
      route(address, "a second launch");
    }
  });
  app.on("open-url", (event, address) => {
    event.preventDefault();
    route(address, "the operating system");
  });
  if (app.isPackaged) {
    takeAppLinkScheme(app, log);
  }
  const launchAddress = findAppLinkArgument(process.argv.slice(1));
  if (launchAddress !== undefined) {
    route(launchAddress, "the launch's command line");
  }
}

/**
 * Registers this install as the scheme's handler, displacing any other app that held it, and logs
 * the app it displaced or a registration the system refused.
 */
function takeAppLinkScheme(app: AppLinkHandlerOptions["app"], log: AppLinkHandlerOptions["log"]) {
  const displacedHolder = app.isDefaultProtocolClient(APP_LINK_SCHEME)
    ? ""
    : app.getApplicationNameForProtocol(`${APP_LINK_SCHEME}://`);
  if (!app.setAsDefaultProtocolClient(APP_LINK_SCHEME)) {
    log.write({
      level: "error",
      source: LOG_SOURCE,
      message:
        `the system refused this app as the ${APP_LINK_SCHEME}:// link handler` +
        (displacedHolder === "" ? "" : `; ${displacedHolder} keeps the links`),
    });
  } else if (displacedHolder !== "") {
    log.write({
      level: "notice",
      source: LOG_SOURCE,
      message: `this app took the ${APP_LINK_SCHEME}:// links from ${displacedHolder}`,
    });
  }
}

/**
 * The `sidekicks:` argument on a command line, or `undefined` when it carries none. Found by its
 * scheme, never by its place: Chromium adds switches, and the order can change.
 */
function findAppLinkArgument(commandLine: readonly string[]): string | undefined {
  return commandLine.find((argument) => APP_LINK_ARGUMENT.test(argument));
}
