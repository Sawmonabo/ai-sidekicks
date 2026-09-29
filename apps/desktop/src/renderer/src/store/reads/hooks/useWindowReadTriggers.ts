import { useEffect } from "react";

import type { ReadTriggerTarget } from "../read-triggers.js";
import type { TransportReconnectObservable } from "@renderer/lib/transport-reconnect.js";

/**
 * The three triggers that are properties of the WINDOW rather than of a session.
 *
 * A node-scoped reading — this node's provider accounts, this node's declared driver
 * capabilities, this machine's health — wires exactly these: it holds no session, so
 * no session's timeline bears on it, and pretending otherwise would tie one node-wide
 * answer to whichever session happened to be open.
 *
 * THE TRANSPORT SIGNAL IS REQUIRED, and it is the half that was missing. Reconnect had
 * exactly one producer in the console — the session store's own repair edge, wired by
 * `useSessionReadTriggers` below — so a reading with no session had no reconnect at
 * all: a node-wide list read once at mount stayed on screen through a wire outage with
 * nothing saying it was old. It is a required parameter rather than an optional one on
 * this module's own stated rule: a reading added later must not be able to ship with
 * two of the three, and an optional signal is exactly how it would.
 *
 * A window-scoped reading whose transport has never gone away pays nothing for it. The
 * signal emits on an EDGE, so a subscription that never sees one never wakes.
 */
export function useWindowReadTriggers(
  reader: ReadTriggerTarget,
  transportReconnect: TransportReconnectObservable,
): void {
  useEffect(() => {
    // In an effect and not in the render body: a render React discards would
    // otherwise put a call on the wire for a view nobody ever saw.
    reader.requestRead("subscribe");
  }, [reader]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const onWindowFocused = (): void => {
      reader.requestRead("window-focus");
    };
    window.addEventListener("focus", onWindowFocused);
    return () => {
      window.removeEventListener("focus", onWindowFocused);
    };
  }, [reader]);

  useEffect(
    () =>
      transportReconnect.subscribe(() => {
        reader.requestRead("reconnect");
      }),
    [reader, transportReconnect],
  );
}
