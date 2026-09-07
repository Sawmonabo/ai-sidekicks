// What the operating system has said about notifications, where it has said anything.
//
// Its own module because the page beside it declares one component, which is this
// package's rule, and because the four states below are a claim worth reading on their
// own: the notice is the one place the console tells a person that the machine will
// not do what the switch above describes.

import { type ReactNode } from "react";

import { Nothing } from "../../../primitives/index.js";
import type { OsNotificationPermissionReading } from "./stored-attention-preferences.js";

/**
 * FOUR STATES AND ONE OF THEM IS SILENCE. A granted permission needs no notice — the
 * machine is doing what the switch above describes — so the granted arm renders
 * nothing at all rather than a line congratulating the reader. The other three are
 * each a different fact: denied, never asked, and never able to ask.
 *
 * NOT A REASON TO SUPPRESS ANYTHING. `Spec-019` requires actionable attention to
 * survive a denied permission, so this notice says what the desktop will not do and
 * says in the same breath that the console still will. It is deliberately not an
 * error: a person who declined desktop notifications made a choice, and reporting it
 * back as a failure would be the console arguing with them.
 */
export function OsPermissionNotice(props: {
  readonly reading: OsNotificationPermissionReading;
}): ReactNode {
  const { reading } = props;
  if (reading.kind === "unavailable") {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title="This console cannot see whether the operating system allows notifications."
        detail="No shell reading answers that question on this build, so nothing is claimed about it in either direction. Everything waiting on you still reaches the rail and the notification center."
      />
    );
  }
  if (reading.kind === "unread" || reading.status === "granted") {
    return null;
  }
  return (
    <p className="meridian-settings-page__aside">
      {reading.status === "denied"
        ? "This machine is not permitting desktop notifications, so none will be raised here whatever the switch above says. Everything waiting on you still reaches the rail and the notification center."
        : "This machine has not been asked yet whether it permits desktop notifications, so none will be raised until it is. Everything waiting on you still reaches the rail and the notification center."}
    </p>
  );
}
