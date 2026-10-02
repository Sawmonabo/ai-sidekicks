import { useEffect } from "react";

import { requestReadOnWindowFocus, type ReadTriggerTarget } from "../read-triggers.js";
import type { TransportReconnectObservable } from "@renderer/lib/transport-reconnect.js";

/**
 * The three triggers that are properties of the window rather than of a session.
 *
 * A machine-scoped reading (the provider accounts, declared driver capabilities, this
 * machine's health) holds no session, so no session's timeline bears on it.
 *
 * The transport signal is required: the session store's repair edge was the console's only
 * reconnect producer, so a session-less reading would stay on screen through a wire outage with
 * nothing saying it was old. Required rather than optional so a reading added later cannot ship
 * with two of the three. The signal emits on an edge, so a reading whose transport never went
 * away pays nothing for it.
 */
export function useWindowReadTriggers(
  reader: ReadTriggerTarget,
  transportReconnect: TransportReconnectObservable,
): void {
  useEffect(() => {
    // In an effect, not the render body: a discarded render would otherwise call the wire for a
    // view nobody saw.
    reader.requestRead("subscribe");
  }, [reader]);

  useEffect(() => requestReadOnWindowFocus(reader), [reader]);

  useEffect(
    () =>
      transportReconnect.subscribe(() => {
        reader.requestRead("reconnect");
      }),
    [reader, transportReconnect],
  );
}
