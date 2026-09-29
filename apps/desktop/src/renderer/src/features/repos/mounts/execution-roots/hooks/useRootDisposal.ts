import { useCallback, useEffect, useMemo, useState } from "react";

import type { ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { CONTROLLER_DISPOSAL } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import {
  RootDisposalController,
  type DisposalOperations,
  type DisposalReading,
  type RootDisposalHost,
} from "../disposal-controller.js";
import type { DisposalSubject } from "../disposal-subject.js";

/** Nothing sent. */
export const DISPOSAL_IDLE: DisposalReading = { status: "idle" };

/** What the hook hands a confirmation: the reading, and the two things it can ask for. */
export interface DisposalBinding {
  readonly reading: DisposalReading;
  readonly send: () => void;
  readonly clear: () => void;
}

/** Bind one root's disposal controller to a confirmation, keyed on the root's id. */
export function useRootDisposal(
  bridge: ConsoleBridge,
  subject: DisposalSubject,
  operations: DisposalOperations,
): DisposalBinding {
  const [reading, setReading] = useState<DisposalReading>(DISPOSAL_IDLE);
  // THE HOST IS ONE OBJECT FOR THE LIFE OF THE SURFACE, over React's own stable state
  // setter: the resource seam holds the factory's product against a key, and a host
  // minted per render would hand the controller a reporter the next pass replaces.
  const host = useMemo<RootDisposalHost>(() => ({ recordDisposal: setReading }), []);
  const { value: controller } = useSubjectScopedResource(
    bridge,
    subject.rootId,
    () => new RootDisposalController({ operations, subject, host }),
    CONTROLLER_DISPOSAL,
  );
  // A NEW CONTROLLER MEANS A NEW SUBJECT, and the settlement on screen belongs to the
  // old one. Cleared here rather than left standing, so a second row's confirmation
  // never opens already reporting the first row's answer.
  useEffect(() => {
    setReading(DISPOSAL_IDLE);
  }, [controller]);
  const send = useCallback(() => {
    void controller.send();
  }, [controller]);
  // CLEARS WHAT IS ON SCREEN AND CANCELS NOTHING. A call already on the wire is not
  // recallable, and the controller's own guard is what keeps a reopened confirmation
  // from sending a second one behind it.
  const clear = useCallback(() => {
    setReading(DISPOSAL_IDLE);
  }, []);
  return { reading, send, clear };
}
