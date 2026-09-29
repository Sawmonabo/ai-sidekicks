// Whether an OS notification this console emits will reach a person at all.
//
// OS notifications denied is a state the notification center is the only surface for.
// `native.showNotification` returns `void`, so a denial is indistinguishable from a
// delivery at the moment of emission; the bridge's `native.getNotificationPermission`
// is what reports it.
//
// WHY THE RENDERER'S OWN `Notification.permission` IS NOT THE INSTRUMENT. It answers
// about the RENDERER's Web notification API, and this console emits through the main
// process. Two different subjects with one word between them: a renderer that has
// never been granted the Web permission can sit in front of a shell that shows every
// notification it asks for, and the reverse holds on a host where the app's own
// entitlement was revoked. Reading one and reporting the other is the wrong
// instrument, whatever it answers.
//
// THE READING IS ADVISORY AND GATES NOTHING ON THE WAY OUT. Emission is the shell's
// act and the OS is its authority: do-not-disturb lives in the main process, and the
// console honors nothing of its own. So a reading this console could not obtain
// suppresses no emission — it would suppress every one on every live host, which is
// exactly the state the shell was built to decide — and the one arm that changes what
// a person sees is `withheld`, where the center says it is the only surface these
// items reach.
//
// WHAT IS HERE IS THE FOLD AND NOT THE READ. The probe, its scheduling, and the rule
// that decides which of two overlapping answers is the live one are
// `bridge/os-notification-permission.ts`'s. This fold asks "will an emission reach
// anybody"; the notifications settings page says something different for each state,
// so the reading crosses the door unfolded and each consumer folds it.

import type { OsNotificationPermissionReading } from "../../bridge/index.js";

/**
 * What the console may say about the OS notification path.
 *
 * Three arms and not four: `granted` and `not-determined` are both `permitted`,
 * because a machine nobody has asked yet is a machine whose first emission raises the
 * system's own consent flow — and reporting that as a denial would put "this is the
 * only surface" in front of someone whose notifications work.
 *
 * `unread` covers a read in flight and a platform the shell cannot read the permission
 * on. Both mean the console does not know, and there is nothing to say about a fact it
 * has not got.
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
 * Named constants rather than a literal per settlement, because this reading is
 * re-read and every re-read publishes: a fresh object per answer would re-identify
 * the value on every focus, re-render the center, and re-mint the context object the
 * window's attention binding memoises — for an answer that did not move. Three
 * arms, three objects, and an unchanged answer compares equal at the one comparison
 * `useSyncExternalStore` performs.
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
