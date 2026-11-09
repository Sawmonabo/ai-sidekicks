// Main's start of the client helper, the utility process that holds the desktop's one connection
// to the daemon, and whether main's links to the daemon present its token. The helper is never
// forked with `disclaim`, since the daemon admits it only while the app is its responsible process.

import path from "node:path";

import { app, utilityProcess, type UtilityProcess } from "electron";

/** The helper's bundle, which the build writes beside main's own. */
const CLIENT_HELPER_ENTRY = path.join(import.meta.dirname, "client-helper.js");

/** The helper's name in the app's process metrics and its process-gone events. */
const CLIENT_HELPER_SERVICE_NAME = "Client Helper";

/** Forks the client helper; it connects once main asks. */
export function startClientHelper(): UtilityProcess {
  return utilityProcess.fork(CLIENT_HELPER_ENTRY, [], {
    serviceName: CLIENT_HELPER_SERVICE_NAME,
  });
}

/**
 * Whether main's links to the daemon present the token file's token: every one but the packaged
 * Mac app's, which the daemon admits by its code signature.
 */
export function isTokenPresented(): boolean {
  return !(app.isPackaged && process.platform === "darwin");
}
