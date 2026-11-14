// Where the service keeps a pasted token, read from its status once per mount and apart from the
// account registry, so a status read the service refuses costs only the line that names it.

import { useEffect, useState } from "react";

import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { secretsPlaceOf, type SecretsPlace } from "../secrets-place.js";

/**
 * Where the service keeps a pasted token, or `undefined` while its status read is out or after
 * the service refused it, when nothing names the place.
 */
export function useSecretsPlace(bridge: PlatformBridge): SecretsPlace | undefined {
  const [secretsPlace, setSecretsPlace] = useState<SecretsPlace | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    void callDaemon(bridge, "daemon.status.read", {}, { signal: controller.signal }).then(
      (reply) => {
        if (reply.status === "served" && !controller.signal.aborted) {
          setSecretsPlace(secretsPlaceOf(reply.value.secretsFile));
        }
      },
    );
    return () => {
      controller.abort();
    };
  }, [bridge]);
  return secretsPlace;
}
