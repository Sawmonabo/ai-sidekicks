// What a person reads when this window could not reach the updater, which runs in main. Each is a
// fixed sentence, never the message the rejection carried: it crossed IPC from main, and may name
// a channel or a stack the person cannot act on.

/** The sentence for each updater act this window could not get to main, by the act. */
export const UPDATER_UNREACHABLE_DETAIL: Readonly<
  Record<"read" | "check" | "download" | "restart", string>
> = {
  read: "Could not read the update status.",
  check: "Could not check for updates.",
  download: "Could not download the update.",
  restart: "Could not restart to install the update.",
};
