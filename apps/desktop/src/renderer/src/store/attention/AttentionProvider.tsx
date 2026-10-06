// The one attention read this window performs, mounted for the window's lifetime so navigating
// to another destination does not throw its answer away. The destination consumes this reading
// instead of opening its own, so the notification center and the all-sessions list cannot
// disagree about what needs a person. The session directory is read here and provided beside
// it. The calls and window handles come in from the composition; nothing here polls or draws
// markup.

import { useCallback, useMemo, type ReactNode } from "react";

import { type Clock } from "#renderer/lib/clock.js";
import { type SessionDirectoryFeed } from "../session/directory/state.js";
import { sessionDirectoryFeeds } from "../session/directory/feeds.js";
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
  /** The window's feed of the service's sessions. */
  readonly sessionDirectoryFeed: SessionDirectoryFeed;
  /** The call that reads the attention projection. */
  readonly readAttention: AttentionProjectionReadCall;
  readonly sessionStoreRegistry: SessionStoreRegistry;
  /** The window's clock, which the attention read's scheduling runs on. */
  readonly clock: Clock;
}

/**
 * Performs the read for the window's lifetime and provides it to whatever is below. The
 * composition mounts it, never a route.
 */
export function AttentionProvider(props: AttentionProviderProps): React.JSX.Element {
  const directory = useSessionDirectory(props.sessionDirectoryFeed);
  const reading = useAttentionProjection(
    props.readAttention,
    props.sessionStoreRegistry,
    props.clock,
  );
  const { sessionDirectoryFeed } = props;
  const recheckDirectory = useCallback(() => {
    sessionDirectoryFeeds.reread(sessionDirectoryFeed);
  }, [sessionDirectoryFeed]);
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
