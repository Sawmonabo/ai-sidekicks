// Main's start of the client helper: the utility process that holds the desktop's one connection
// to the daemon. It is never forked with `disclaim`, since the daemon admits the helper only while
// the app is its responsible process.

import path from "node:path";

import { app, utilityProcess, type UtilityProcess } from "electron";

import type { MainToClientHelperMessage } from "./messages.js";

/** The helper's bundle, which the build writes beside main's own. */
const CLIENT_HELPER_ENTRY = path.join(import.meta.dirname, "client-helper.js");

/** The helper's name in the app's process metrics and its process-gone events. */
const CLIENT_HELPER_SERVICE_NAME = "Client Helper";

/**
 * Forks the client helper and tells it to connect, presenting the token unless this is the
 * packaged Mac app, which the daemon admits by its code signature.
 */
export function startClientHelper(): UtilityProcess {
  const helper = utilityProcess.fork(CLIENT_HELPER_ENTRY, [], {
    serviceName: CLIENT_HELPER_SERVICE_NAME,
  });
  const connect: MainToClientHelperMessage = {
    kind: "link.connect",
    isPackaged: app.isPackaged,
    platform: process.platform,
  };
  helper.postMessage(connect);
  return helper;
}
