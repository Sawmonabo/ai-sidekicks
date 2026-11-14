// The path of each lost folder a banner names, read once per mount with `repoMount.read`: the
// health event names the mount and not its folder. A read the daemon refused is asked again when
// the transport comes back, since a read refused across a reconnect would otherwise leave its
// banner unnamed for the rest of the visit.

import { useEffect, useReducer, useState } from "react";

import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";

import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/**
 * The folder path of each mount in `repoMountIds` whose read landed, as the person entered it. A
 * refused read reaches `onReadRefused`, and its banner waits for no path until a reconnect reads
 * it again.
 */
export function useLostFolderPaths(
  bridge: PlatformBridge,
  repoMountIds: readonly string[],
  onReadRefused: (repoMountId: string, refusal: ExtendedRefusal) => void,
): ReadonlyMap<string, string> {
  const [pathsByMount, setPathsByMount] = useState<ReadonlyMap<string, string>>(new Map());
  const [reconnectCount, countReconnect] = useReducer((count: number) => count + 1, 0);
  const unreadKey = repoMountIds.filter((id) => !pathsByMount.has(id)).join(" ");

  useEffect(() => bridge.transportReconnect.subscribe(countReconnect), [bridge]);

  useEffect(() => {
    if (unreadKey === "") {
      return undefined;
    }
    const abort = new AbortController();
    for (const repoMountId of unreadKey.split(" ")) {
      void callDaemon(
        bridge,
        "repoMount.read",
        { repoMountId: heldIdAsWireId<RepoMountId>(repoMountId) },
        { signal: abort.signal },
      ).then((reply) => {
        if (reply.status === "served") {
          setPathsByMount((current) => new Map(current).set(repoMountId, reply.value.localPath));
        } else if (!abort.signal.aborted) {
          onReadRefused(repoMountId, reply.refusal);
        }
      });
    }
    return () => {
      abort.abort();
    };
  }, [bridge, unreadKey, onReadRefused, reconnectCount]);

  return pathsByMount;
}
