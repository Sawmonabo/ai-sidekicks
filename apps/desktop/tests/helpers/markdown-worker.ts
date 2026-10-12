// The renderer unit tier's markdown worker: the tier runs where no worker can, so the app's one
// markdown worker is the in-process stand-in, which parses through the worker's own serializer with
// Sätteri's Node build and makes copies through the worker's own answers. Only the thread hop is
// left out, and the slices a copy's text is encoded and decoded in, which run at once; the page's
// end of the worker reads every tree exactly as it does in the app. A suite
// holds the app's worker's answers through `appMarkdownWorkers`, to see the frames drawn while a
// parse is still out.

import { vi } from "vitest";

import type * as markdownWorkerConnection from "#renderer/components/Markdown/worker/connection.js";
import { InThreadMarkdownWorkers } from "#renderer/components/Markdown/worker/connection.test-support.js";

/** The stand-in workers the app's markdown worker connection starts, oldest first. */
export const appMarkdownWorkers: InThreadMarkdownWorkers = new InThreadMarkdownWorkers();

vi.mock("#renderer/components/Markdown/worker/connection.js", async (importOriginal) => {
  const original = await importOriginal<typeof markdownWorkerConnection>();
  // The tier's window schedules no tasks, so each slice of a copy's text runs at once.
  const { TASKS_AT_ONCE } = await import("#test/helpers/tasks-at-once.js");
  return {
    ...original,
    // Read when a worker starts: the stand-ins' module imports this one, so they are made after it.
    markdownWorker: new original.MarkdownWorkerConnection(
      () => appMarkdownWorkers.start(),
      TASKS_AT_ONCE,
    ),
  };
});
