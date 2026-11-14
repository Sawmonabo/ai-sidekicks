// What a person reads when this window could not reach the updater, which runs in main. Each is a
// fixed line, never the message the rejection carried: it crossed IPC from main, and may name
// a channel or a stack the person cannot act on.

/** The line for each updater act this window could not get to main, by the act. */
export const UPDATER_UNREACHABLE_DETAIL: Readonly<
  Record<"read" | "check" | "download" | "restart", string>
> = {
  read: "Couldn't load update status",
  check: "Couldn't check for updates",
  download: "Couldn't download update",
  restart: "Couldn't restart to install update",
};
