// Every editor the app looks for, each saying whether this machine has it, as main finds them.
//
// Nothing announces that an editor was installed or removed, so the list is read again whenever
// the window regains focus or the transport comes back: a person who installs an editor and
// returns to the page sees it pickable.

import { useMemo } from "react";

import type { EditorEntry } from "#shared/preload-api.js";
import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { CONTROLLER_DISPOSAL } from "#renderer/lib/subject-scoped/disposal.js";
import type { Clock } from "#renderer/lib/clock.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { usePushDrivenRead } from "#renderer/store/reads/hooks/usePushDrivenRead.js";
import { useWindowReadTriggers } from "#renderer/store/reads/hooks/useWindowReadTriggers.js";
import { PushDrivenRead, type PushDrivenReadState } from "#renderer/store/reads/push-driven.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  type ReadTriggerTarget,
} from "#renderer/store/reads/triggers.js";

/** The editor list and the act that reads it again after a failed read. */
export interface EditorListBinding {
  readonly state: PushDrivenReadState<readonly EditorEntry[]>;
  readonly readAgain: () => void;
}

/** Read the editors this machine has while the caller is mounted, on the window's `clock`. */
export function useEditorList(bridge: PlatformBridge, clock: Clock): EditorListBinding {
  const { value: read } = useSubjectScopedResource(
    bridge,
    undefined,
    () =>
      new PushDrivenRead<readonly EditorEntry[]>({
        clock,
        origin: EDITOR_LIST_ORIGIN,
        read: () => bridge.native.listEditors(),
        subscribe: () => () => undefined,
      }),
    CONTROLLER_DISPOSAL,
  );
  const triggerTarget = useMemo<ReadTriggerTarget>(
    () => ({
      triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
      requestRead: (reason) => {
        read.refresh(reason);
      },
    }),
    [read],
  );
  useWindowReadTriggers(triggerTarget, bridge.transportReconnect);
  return {
    state: usePushDrivenRead(read),
    readAgain: () => {
      read.refresh("user-request");
    },
  };
}

/** Names the editor list read in a refusal. */
const EDITOR_LIST_ORIGIN = "editor-list";
