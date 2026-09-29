// The one attention read this window performs, for as long as the window is open.
//
// WHY IT IS MOUNTED FOR THE WINDOW'S LIFETIME. A window that has simply moved to another
// destination is not an unreachable machine: the daemon is answering and this window is
// following it. A read mounted on a destination would throw its answer away whenever
// somebody navigated. The window's composition mounts this provider, so the reading is
// live from the moment the window resolves a bridge until it tears down.
//
// AND IT IS STILL EXACTLY ONE READ. The destination consumes what this binding holds
// rather than opening its own — the notification center renders the same reading the
// all-sessions list takes each row's severity from, so the panel and the list cannot
// disagree about what needs a person, which two reads, however carefully written,
// eventually would.
//
// THE DIRECTORY COMES WITH IT, read once and provided beside the reading, so the
// destination takes both from the same place.
//// THE CALLS AND THE WINDOW'S HANDLES ARE THE COMPOSITION'S. This module holds only how
// the answers are kept and provided; the calls that list the node's sessions and read
// the projection, the attention subscription, the reconnect signal, the clock and the
// session store registry are handed in, so nothing here reaches a wire or a service.
//
// NOTHING HERE POLLS AND NOTHING HERE RENDERS. The attention read re-runs when the
// session projections underneath it move, through the console's one push-driven read
// discipline; this component draws no markup and returns the subtree it was handed.
// The directory re-reads on the window's own focus trigger and on a settled act's
// explicit ask, which are the two moments `store/read/read-triggers.ts` already names
// for a node-scoped reading.

import { useCallback, useMemo, type ReactNode } from "react";

import { type ConsoleClock } from "@renderer/lib/clock.js";
import type { TransportReconnectObservable } from "@renderer/lib/transport-reconnect.js";
import {
  requestSessionDirectoryRead,
  type SessionDirectoryReadCall,
  type SessionDirectoryState,
} from "../session-directory/session-directory.js";
import { useSessionDirectory } from "../session-directory/useSessionDirectory.js";
import { type SessionStoreRegistry } from "../session/session-store-registry.js";
import { type AttentionReading } from "./attention-summary.js";
import {
  useAttentionProjection,
  type AttentionProjectionReadCall,
  type AttentionSubscribeCall,
} from "./hooks/useAttentionProjection.js";
import { SessionAttentionContext } from "./hooks/useAttention.js";

/**
 * What this window holds about the sessions it can name, read once.
 *
 * The members are what the consumers between them need, and no more: the destination
 * renders the reading and can ask for the directory again.
 */
export interface SessionAttention {
  /** The node's own session list, as the read settled it. */
  readonly directory: SessionDirectoryState;
  readonly reading: AttentionReading;
  /** Declare the node's directory stale, so it is read again. */
  readonly recheckDirectory: () => void;
}

/** The subtree it provides for, and the calls and window handles it keeps answers from. */
export interface SessionAttentionBindingProps {
  readonly children: ReactNode;
  /** The call that lists the node's sessions. */
  readonly readDirectory: SessionDirectoryReadCall;
  /** The call that reads the attention projection. */
  readonly readAttention: AttentionProjectionReadCall;
  /** The bridge's signal that the attention projection moved. */
  readonly subscribeToAttention: AttentionSubscribeCall;
  /** The bridge's reconnect signal, which re-reads the directory. */
  readonly transportReconnect: TransportReconnectObservable;
  readonly sessionStoreRegistry: SessionStoreRegistry;
  /** The window's clock, which the attention read's scheduling runs on. */
  readonly clock: ConsoleClock;
}

/**
 * Perform the read for the window's lifetime and provide it to whatever is below.
 *
 * MOUNTED BY THE COMPOSITION AND NEVER BY A ROUTE, so this component's lifetime is the
 * window's.
 */
export function SessionAttentionBinding(props: SessionAttentionBindingProps): React.JSX.Element {
  const directory = useSessionDirectory(props.readDirectory, props.transportReconnect);
  const reading = useAttentionProjection(
    props.readAttention,
    props.sessionStoreRegistry,
    props.clock,
    props.subscribeToAttention,
  );
  const { readDirectory } = props;
  const recheckDirectory = useCallback(() => {
    requestSessionDirectoryRead(readDirectory);
  }, [readDirectory]);
  const held = useMemo<SessionAttention>(
    () => ({
      directory,
      reading,
      recheckDirectory,
    }),
    [directory, reading, recheckDirectory],
  );
  return (
    <SessionAttentionContext.Provider value={held}>
      {props.children}
    </SessionAttentionContext.Provider>
  );
}
