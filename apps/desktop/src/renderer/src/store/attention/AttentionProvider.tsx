// The one attention read this window performs, mounted for the window's lifetime so navigating
// to another destination does not throw its answer away. The destination consumes this reading
// instead of opening its own, so the notification center and the all-sessions list cannot
// disagree about what needs a person. The session directory is read here and provided beside
// it. The calls and window handles come in from the composition; nothing here polls or draws
// markup.

import { useCallback, useMemo, type ReactNode } from "react";

import { type Clock } from "#renderer/lib/clock.js";
import type { TransportReconnectObservable } from "#renderer/lib/transport-reconnect.js";
import { type SessionDirectoryReadCall } from "../session/directory/state.js";
import { requestSessionDirectoryRead } from "../session/directory/staleness.js";
import { useSessionDirectory } from "../session/directory/useSessionDirectory.js";
import { type SessionStoreRegistry } from "../session/registry.js";
import {
  useAttentionProjection,
  type AttentionProjectionReadCall,
} from "./hooks/useAttentionProjection.js";
import { WindowAttentionContext, type WindowAttention } from "./hooks/useAttention.js";

/** The subtree it provides for, and the calls and window handles it keeps answers from. */
export interface AttentionProviderProps {
  readonly children: ReactNode;
  /** The call that lists the service's sessions. */
  readonly readDirectory: SessionDirectoryReadCall;
  /** The call that reads the attention projection. */
  readonly readAttention: AttentionProjectionReadCall;
  /** The bridge's reconnect signal, which re-reads the directory. */
  readonly transportReconnect: TransportReconnectObservable;
  readonly sessionStoreRegistry: SessionStoreRegistry;
  /** The window's clock, which the attention read's scheduling runs on. */
  readonly clock: Clock;
}

/**
 * Performs the read for the window's lifetime and provides it to whatever is below. The
 * composition mounts it, never a route.
 */
export function AttentionProvider(props: AttentionProviderProps): React.JSX.Element {
  const directory = useSessionDirectory(props.readDirectory, props.transportReconnect);
  const reading = useAttentionProjection(
    props.readAttention,
    props.sessionStoreRegistry,
    props.clock,
  );
  const { readDirectory } = props;
  const recheckDirectory = useCallback(() => {
    requestSessionDirectoryRead(readDirectory);
  }, [readDirectory]);
  const held = useMemo<WindowAttention>(
    () => ({
      directory,
      reading,
      recheckDirectory,
    }),
    [directory, reading, recheckDirectory],
  );
  return (
    <WindowAttentionContext.Provider value={held}>{props.children}</WindowAttentionContext.Provider>
  );
}
