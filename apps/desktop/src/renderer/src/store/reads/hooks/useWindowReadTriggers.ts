import { useEffect } from "react";

import { requestReadOnWindowFocus, type ReadTriggerTarget } from "../triggers.js";
import { useOwnerWindow } from "#renderer/hooks/owner-window/useOwnerWindow.js";
import type { TransportReconnectObservable } from "#renderer/lib/transport-reconnect.js";

/**
 * The three triggers that are properties of the window rather than of a session.
 *
 * A machine-scoped reading (the provider accounts, declared driver capabilities, this
 * machine's health) holds no session, so no session's transcript bears on it.
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
  const ownerWindow = useOwnerWindow();
  useEffect(() => {
    // In an effect, not the render body: a discarded render would otherwise call the wire for a
    // view nobody saw.
    reader.requestRead("subscribe");
  }, [reader]);

  useEffect(() => requestReadOnWindowFocus(reader, ownerWindow), [reader, ownerWindow]);

  useEffect(
    () =>
      transportReconnect.subscribe(() => {
        reader.requestRead("reconnect");
      }),
    [reader, transportReconnect],
  );
}
