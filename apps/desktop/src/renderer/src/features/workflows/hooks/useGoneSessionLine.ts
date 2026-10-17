// The `Session not found` line a control pointing into a session draws on itself when that
// session is gone, standing until the next act; each press that finds it gone raises it again.

import { useCallback, useState } from "react";

import { useUntilNextAct } from "#renderer/hooks/useUntilNextAct.js";
import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import type { SessionPointerOutcome } from "#renderer/features/workflows/open-session.js";

/** A control's `Session not found` line: the raise it stands for, and how the control follows. */
export interface GoneSessionLine {
  /** The raise the line answers while it stands, or `undefined` while no line is drawn. */
  readonly raisedKey: string | undefined;
  /** Follow one press's pointer, raising the line when its session is gone. */
  readonly follow: (pointer: Promise<SessionPointerOutcome>) => void;
}

/** The `Session not found` line one control draws on itself. */
export function useGoneSessionLine(): GoneSessionLine {
  const [goneCount, setGoneCount] = useState(0);
  const raisedKey = goneCount === 0 ? undefined : String(goneCount);
  const isStanding = useUntilNextAct(raisedKey);
  const follow = useCallback((pointer: Promise<SessionPointerOutcome>) => {
    pointer.then(
      (outcome) => {
        if (outcome === "gone") {
          setGoneCount((count) => count + 1);
        }
      },
      (failure: unknown) => {
        recordRejectedRequest("features/workflows", "session-pointer-not-followed", failure);
      },
    );
  }, []);
  return { raisedKey: isStanding ? raisedKey : undefined, follow };
}
