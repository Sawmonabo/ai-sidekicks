import { useCallback, useEffect, useMemo, useState } from "react";

import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { CONTROLLER_DISPOSAL } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import {
  RootRemovalController,
  type RootRemovalOperations,
  type RootRemovalReading,
  type RootRemovalHost,
} from "../root-removal-controller";
import type { RootRemovalSubject } from "../root-removal-subject";

/** Nothing sent. */
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
  subject: RootRemovalSubject,
  operations: RootRemovalOperations,
): RootRemovalBinding {
  const [reading, setReading] = useState<RootRemovalReading>(ROOT_REMOVAL_IDLE);
  // THE HOST IS ONE OBJECT FOR THE LIFE OF THE SURFACE, over React's own stable state
  // setter: the resource seam holds the factory's product against a key, and a host
  // minted per render would hand the controller a reporter the next pass replaces.
  const host = useMemo<RootRemovalHost>(() => ({ recordRemoval: setReading }), []);
  const { value: controller } = useSubjectScopedResource(
    bridge,
    subject.rootId,
    () => new RootRemovalController({ operations, subject, host }),
    CONTROLLER_DISPOSAL,
  );
  // A NEW CONTROLLER MEANS A NEW SUBJECT, and the settlement on screen belongs to the
  // old one. Cleared here rather than left standing, so a second row's confirmation
  // never opens already reporting the first row's answer.
  useEffect(() => {
    setReading(ROOT_REMOVAL_IDLE);
  }, [controller]);
  const send = useCallback(() => {
    void controller.send();
  }, [controller]);
  // CLEARS WHAT IS ON SCREEN AND CANCELS NOTHING. A call already on the wire is not
  // recallable, and the controller's own guard is what keeps a reopened confirmation
  // from sending a second one behind it.
  const clear = useCallback(() => {
    setReading(ROOT_REMOVAL_IDLE);
  }, []);
  return { reading, send, clear };
}
