// Whether the operating system lets this app post a notification. Electron has no read of it on
// macOS (its `Notification` offers `isSupported()` alone), so `notify-status` reads it: its read
// resolves a promise, never blocks main and never rejects, an environment it cannot read answering
// `unsupported`. Where that library reads nothing (Linux), its answer is `unsupported` too.

import type { Authorization, NotificationStatus } from "notify-status";

import type { NotificationPermission } from "@shared/preload-api.js";

/** Reads the host's notification status; `getNotificationStatus` from `notify-status`. */
export type NotificationStatusReader = () => Promise<NotificationStatus>;

/** The library's authorization words, in the bridge's permission words. */
const PERMISSION_STATE_BY_AUTHORIZATION: Readonly<
  Record<Authorization, NotificationPermission["state"]>
> = {
  granted: "granted",
  denied: "denied",
  notDetermined: "not-determined",
  unsupported: "unsupported",
};

/**
 * The operating system's notification permission for this app. `granted` covers a provisional
 * grant as well, which posts quietly to the notification center.
 */
export async function readNotificationPermission(
  readStatus: NotificationStatusReader,
): Promise<NotificationPermission> {
  const { authorization } = await readStatus();
  return { state: PERMISSION_STATE_BY_AUTHORIZATION[authorization] };
}
