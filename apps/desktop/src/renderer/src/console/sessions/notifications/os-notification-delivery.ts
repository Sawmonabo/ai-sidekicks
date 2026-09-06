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

import {
  useSettledGrowthRead,
  type GrowthPort,
  type SettledReadRefusal,
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

/** What the permission read settles to, either kind. */
type SettledPermission =
  | Awaited<ReturnType<GrowthPort["shellNotificationPermissionRead"]>>
  | SettledReadRefusal;

/** The reading, given its one read's settlement. */
function settledDelivery(settlement: SettledPermission): OsNotificationDelivery {
  if (settlement.status !== "served") {
    return { status: "unread" };
  }
  return settlement.value.state === "denied" ? { status: "withheld" } : { status: "permitted" };
}

/**
 * Read this machine's notification permission once, for as long as the caller is
 * mounted.
 *
 * Keyed on the port exactly as the session directory next door is, and for the same
 * reason: the port is the whole subject, it is minted once per bridge, and a bridge
 * swapped underneath — the fixture's scenario switch — re-addresses the holder during
 * the render that first sees the new one.
 */
export function useOsNotificationDelivery(growth: GrowthPort): OsNotificationDelivery {
  const { value } = useSettledGrowthRead<SettledPermission, OsNotificationDelivery>(
    growth,
    undefined,
    () => growth.shellNotificationPermissionRead({}),
    { unsettled: () => ({ status: "unread" }), settled: settledDelivery },
  );
  return value;
}
