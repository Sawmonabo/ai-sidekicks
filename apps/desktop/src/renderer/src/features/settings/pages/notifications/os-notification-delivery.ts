// Whether an OS notification this console emits will reach a person at all.
//
// `native.showNotification` returns `void`, so a denial is indistinguishable from a delivery at
// emission; `native.getNotificationPermission` reports it. The renderer's `Notification.permission`
// is the wrong instrument: it concerns the Web notification API, while this console emits through
// the main process.
//
// The reading is advisory and gates nothing on the way out: the OS is the authority, so an
// unobtainable reading suppresses no emission. Only `withheld` changes what a person sees. This
// file is the fold; the probe and its scheduling are in `os-notification-permission.ts`, and the
// reading is handed out unfolded so each consumer folds it for its own question.

import type { OsNotificationPermissionReading } from "./os-notification-permission.js";

/**
 * What the console may say about the OS notification path.
 *
 * Three arms: `granted` and `not-determined` are both `permitted`, since a machine nobody has
 * asked yet raises the system's own consent flow on the first emission, and reporting that as
 * a denial would mislead someone whose notifications work. `unread` covers a read in flight
 * and a platform whose permission the main process cannot read; the console does not know.
 *
 * @consumedBy the notifications settings page
 */
export type OsNotificationDelivery =
  | { readonly status: "unread" }
  | { readonly status: "permitted" }
  | { readonly status: "withheld" };

/**
 * The three readings, as three values.
 *
 * Named constants so an unchanged answer compares equal at the one comparison
 * `useSyncExternalStore` makes; a fresh object per answer would re-render on every re-read.
 */
const UNREAD_DELIVERY: OsNotificationDelivery = { status: "unread" };
const PERMITTED_DELIVERY: OsNotificationDelivery = { status: "permitted" };
const WITHHELD_DELIVERY: OsNotificationDelivery = { status: "withheld" };

/**
 * The reading of one permission answer. Total, so no call site branches.
 *
 * @consumedBy the notifications settings page
 */
export function deliveryFor(reading: OsNotificationPermissionReading): OsNotificationDelivery {
  if (reading.kind !== "read" || reading.state === "unsupported") {
    return UNREAD_DELIVERY;
  }
  return reading.state === "denied" ? WITHHELD_DELIVERY : PERMITTED_DELIVERY;
}
