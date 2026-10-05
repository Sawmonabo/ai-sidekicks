// What the operating system has said about notifications, where it has said anything: the one
// place the console tells a person the machine will not raise desktop notifications.

import { type ReactNode } from "react";

import type { OsNotificationPermissionReading } from "../os-notification/permission.js";

/**
 * Says so when the machine denied desktop notifications, and draws nothing otherwise.
 *
 * Not an error: a person who declined made a choice, and the copy says the console still
 * reaches them.
 */
export function NotificationPermissionNotice(props: {
  readonly reading: OsNotificationPermissionReading;
}): ReactNode {
  const { reading } = props;
  if (reading.kind === "unread" || reading.state !== "denied") {
    return null;
  }
  return (
    <p className="meridian-settings-page__aside">
      This machine is not permitting desktop notifications, so none will be raised here. Everything
      waiting on you still reaches the rail and the notification center.
    </p>
  );
}
