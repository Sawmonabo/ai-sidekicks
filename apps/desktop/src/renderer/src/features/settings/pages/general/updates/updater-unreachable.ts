// What a person reads when this window could not reach the updater, which runs in main. Each is a
// fixed sentence, never the message the rejection carried: it crossed IPC from main, and may name
// a channel or a stack the person cannot act on.

/** The sentence for each updater act this window could not get to main, by the act. */
export const UPDATER_UNREACHABLE_DETAIL: Readonly<
  Record<"read" | "check" | "download" | "restart", string>
> = {
  read:
    "The update state could not be read. The updater runs in the main process, and this " +
    "window could not reach it.",
  check:
    "The update check could not start. The updater runs in the main process, and this " +
    "window could not reach it.",
  download:
    "The download could not start. The updater runs in the main process, and this window " +
    "could not reach it.",
  restart:
    "The app could not restart to install the update. The updater runs in the main process, " +
    "and this window could not reach it.",
};
