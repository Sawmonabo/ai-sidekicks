// Where the probes find the app drawn. The console document's own contents exist once its window
// is built, so the next contents made are those of the first window it opens.

import type { App, WebContents } from "electron";

/**
 * The contents of the first window the console document opens. Call it after the console window
 * is built and before that document opens a window.
 */
export function firstWindowContents(electronApp: Pick<App, "once">): Promise<WebContents> {
  return new Promise((resolve) => {
    electronApp.once("web-contents-created", (_event, created) => {
      resolve(created);
    });
  });
}
