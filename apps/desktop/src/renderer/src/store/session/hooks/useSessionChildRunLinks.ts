// A lease on the session's shared child-run links read for as long as the caller is mounted.

import { useEffect, useState } from "react";

import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { sessionChildRunLinks, type SessionChildRunLinksRead } from "../child-run-links.js";
import type { SessionStore } from "../store.js";

/**
 * Hold and start `sessionStore`'s shared child-run links read while mounted, building it with
 * `build` when no view holds it yet; `undefined` until the mount effect has taken the lease, so a
 * discarded render opens nothing.
 */
export function useSessionChildRunLinks(
  sessionStore: SessionStore,
  build: () => SessionChildRunLinksRead,
): SessionChildRunLinksRead | undefined {
  const [read, setRead] = useState<SessionChildRunLinksRead | undefined>(undefined);
  // The newest builder, so an inline one does not take the lease again on every render.
  const buildRef = useLatestRef(build);
  useEffect(() => {
    const lease = sessionChildRunLinks.acquire(sessionStore, () => buildRef.current());
    lease.read.start();
    setRead(lease.read);
    return () => {
      lease.release();
      setRead(undefined);
    };
  }, [sessionStore, buildRef]);
  return read;
}
