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
// AND IT IS RE-READ, BECAUSE THE ANSWER MOVES UNDERNEATH IT. A machine nobody has
// asked yet reads `not-determined`, which is `permitted` here — the first emission is
// what raises the system's own consent flow. Read once and never again, that is a
// reading of a question the person has since ANSWERED: a window on a fresh install
// mapped `not-determined` to `permitted`, the first banner raised the prompt, the
// person declined it, and this window went on suppressing the "only surface" sentence
// and treating every later undelivered notification as delivered until the bridge
// underneath it was replaced.
//
// SO IT IS WIRED TO THE CONSOLE'S OWN READ TRIGGERS AND TO NOTHING OF ITS OWN.
// `store/read-triggers.ts` is the one home for "when does a reading go stale", and the
// two window-scoped reasons are exactly this reading's: `subscribe` when a window
// resolves a port, `window-focus` when it comes back — which is when a person who just
// answered a system prompt returns to the console. Nothing here polls, holds a timer,
// or keeps a second record of whether the window has focus; the trigger set owns the
// listener and this module owns the call it results in.

import { useMemo } from "react";

import { settleGrowthRead, type GrowthPort, type SettledReadRefusal } from "../../bridge/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  useSubjectScopedState,
  useWindowReadTriggers,
  type ReadTriggerTarget,
} from "../../store/index.js";

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

/** What the permission read settles to, either kind. */
type SettledPermission =
  | Awaited<ReturnType<GrowthPort["shellNotificationPermissionRead"]>>
  | SettledReadRefusal;

/** The reading, given one read's settlement. */
function settledDelivery(settlement: SettledPermission): OsNotificationDelivery {
  if (settlement.status !== "served") {
    return UNREAD_DELIVERY;
  }
  return settlement.value.state === "denied" ? WITHHELD_DELIVERY : PERMITTED_DELIVERY;
}

/** What a port this window has not read yet holds. Module-level, so it allocates none. */
function unreadDelivery(): OsNotificationDelivery {
  return UNREAD_DELIVERY;
}

/**
 * Read this machine's notification permission, and read it again when it can have
 * changed.
 *
 * Keyed on the port exactly as the session directory next door is, and for the same
 * reason: the port is the whole subject, it is minted once per bridge, and a bridge
 * swapped underneath — the fixture's scenario switch — re-addresses the holder during
 * the render that first sees the new one.
 *
 * THE FIRST READ IS THE TRIGGER SET'S `subscribe` AND NOT AN EFFECT OF ITS OWN. A
 * mount read written here beside the trigger set would put two calls on the wire for
 * one arrival — the shape `provider-quota-feed.ts` records against its own first
 * wiring — so the reading owns one request path and the trigger set decides when it
 * runs.
 *
 * A RE-READ IN FLIGHT LEAVES THE STANDING ANSWER ON SCREEN. The value is published on
 * settlement alone, so the centre never flickers back through "we have not asked" on
 * the way to an answer it already had; and a refused re-read publishes `unread`,
 * which is the honest report of a fact this console can no longer establish rather
 * than the last one it happened to be given.
 */
export function useOsNotificationDelivery(growth: GrowthPort): OsNotificationDelivery {
  const { value, publish } = useSubjectScopedState<OsNotificationDelivery>(
    growth,
    undefined,
    unreadDelivery,
  );
  // Re-minted exactly when the holder is re-addressed, because `publish` is: a port
  // swapped underneath re-reads through the new one, and every render that did not
  // re-address hands the trigger set the same target and asks for nothing.
  const permissionRead = useMemo<ReadTriggerTarget>(
    () => ({
      // No session's timeline bears on a machine-level permission, and the empty
      // declaration is the claim rather than an omission.
      triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
      requestRead: (): void => {
        void settleGrowthRead(growth.shellNotificationPermissionRead({})).then((settlement) => {
          publish(settledDelivery(settlement));
        });
      },
    }),
    [growth, publish],
  );
  useWindowReadTriggers(permissionRead);
  return value;
}
