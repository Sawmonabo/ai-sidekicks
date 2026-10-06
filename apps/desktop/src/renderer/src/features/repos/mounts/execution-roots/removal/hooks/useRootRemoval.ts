import { useCallback, useEffect, useMemo, useState } from "react";

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { CONTROLLER_DISPOSAL } from "#renderer/lib/subject-scoped/disposal.js";
import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import {
  RootRemovalController,
  type RootRemovalOperations,
  type RootRemovalReading,
  type RootRemovalRecorder,
} from "../controller.js";

/** The reading before anything is sent. */
export const ROOT_REMOVAL_IDLE: RootRemovalReading = { status: "idle" };

/** What the hook hands a confirmation: the reading, and the two things it can ask for. */
export interface RootRemovalBinding {
  readonly reading: RootRemovalReading;
  readonly send: () => void;
  readonly clear: () => void;
}

/** Bind one root's removal controller to a confirmation, keyed on the root's id. */
export function useRootRemoval(
  bridge: PlatformBridge,
  rootId: string,
  operations: RootRemovalOperations,
): RootRemovalBinding {
  const [reading, setReading] = useState<RootRemovalReading>(ROOT_REMOVAL_IDLE);
  // One recorder for the confirmation's life, over React's stable setter: the resource seam
  // holds the factory's product against a key, and a per-render recorder would be replaced.
  const recorder = useMemo<RootRemovalRecorder>(() => ({ recordRemoval: setReading }), []);
  const { value: controller } = useSubjectScopedResource(
    bridge,
    rootId,
    () => new RootRemovalController({ operations, rootId, recorder }),
    CONTROLLER_DISPOSAL,
  );
  // A new controller means a new root, and the settlement on screen belongs to the old one,
  // so a second row's confirmation never opens reporting the first row's answer.
  useEffect(() => {
    setReading(ROOT_REMOVAL_IDLE);
  }, [controller]);
  const send = useCallback(() => {
    void controller.send();
  }, [controller]);
  // Clears what is on screen and cancels nothing: a call on the wire is not recallable, and
  // the controller's own guard stops a reopened confirmation sending a second one.
  const clear = useCallback(() => {
    setReading(ROOT_REMOVAL_IDLE);
  }, []);
  return { reading, send, clear };
}
