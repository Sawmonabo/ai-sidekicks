// Whether an OS notification this console emits will reach a person at all.
//
// The notification centre has a state the console could not previously enter:
// "OS notifications denied, in which case the centre is the only surface and says
// so" (`Spec-019 §Fallback Behavior`, carried into the centre by
// `Spec-023 §Console Design (Meridian)`). Nothing on the shipped bridge reports
// that fact — `native.showNotification` returns `void`, so a denial is
// indistinguishable from a delivery from inside the renderer — so the reading is a
// growth-port row and refuses under the live bridge.
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
// act and the OS is its authority: `Spec-023 §Main Process Responsibilities` puts
// do-not-disturb there, and the console honours nothing of its own. So a reading this
// console could not obtain suppresses no emission — it would suppress every one on
// every live host, which is exactly the state the shell was built to decide — and the
// one arm that changes what a person sees is `withheld`, where the centre says it is
// the only surface these items reach.
//
// WHAT IS LEFT HERE IS THE FOLD AND NOT THE READ. The probe, its scheduling, and the
// rule that decides which of two overlapping answers is the live one are
// `bridge/os-notification-permission.ts`', because the notifications settings page
// asks the same machine the same question and a view family may not import its
// sibling. Two folds of one answer is the honest shape: this one asks "will an
// emission reach anybody", and the page says something different for each of the three
// arms — so the reading crosses the door unfolded and each consumer folds it here.

import {
  useOsNotificationPermission,
  type ConsoleBridge,
  type OsNotificationPermissionReading,
} from "../../bridge/index.js";

/**
 * What the console may say about the OS notification path.
 *
 * Three arms and not four: `granted` and `not-determined` are both `permitted`,
 * because a machine nobody has asked yet is a machine whose first emission raises the
 * system's own consent flow — and reporting that as a denial would put "this is the
 * only surface" in front of someone whose notifications work.
 *
 * `unread` covers a read in flight and a read the bridge refused. Both mean the
 * console does not know, and there is nothing to say about a fact it has not got.
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
 * the value on every focus, re-render the centre, and re-mint the context object the
 * window's attention binding memoises — for an answer that did not move. Three
 * arms, three objects, and an unchanged answer compares equal at the one comparison
 * `useSyncExternalStore` performs.
 */
const UNREAD_DELIVERY: OsNotificationDelivery = { status: "unread" };
const PERMITTED_DELIVERY: OsNotificationDelivery = { status: "permitted" };
const WITHHELD_DELIVERY: OsNotificationDelivery = { status: "withheld" };

/** The centre's reading of one permission answer. Total, so no call site branches. */
function deliveryFor(reading: OsNotificationPermissionReading): OsNotificationDelivery {
  if (reading.kind !== "read") {
    return UNREAD_DELIVERY;
  }
  return reading.state === "denied" ? WITHHELD_DELIVERY : PERMITTED_DELIVERY;
}

/**
 * Read this machine's notification permission, and read it again when it can have
 * changed.
 *
 * A RE-READ IN FLIGHT LEAVES THE STANDING ANSWER ON SCREEN, which is the reading's own
 * rule rather than this fold's: the value is published on settlement alone, so the
 * centre never flickers back through "we have not asked" on the way to an answer it
 * already had; and a refused re-read publishes `unavailable`, which folds to `unread`
 * here — the honest report of a fact this console can no longer establish rather than
 * the last one it happened to be given.
 */
export function useOsNotificationDelivery(bridge: ConsoleBridge): OsNotificationDelivery {
  return deliveryFor(useOsNotificationPermission(bridge));
}
