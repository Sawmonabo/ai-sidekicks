// Every editor the app looks for, each saying whether this machine has it, as main finds them.
//
// Nothing announces that an editor was installed or removed, so the list is read again whenever
// the window regains focus or the transport comes back: a person who installs an editor and
// returns to the page sees it pickable.

import type { EditorEntry } from "#shared/preload-api.js";
import type { Clock } from "#renderer/lib/clock.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useWindowTriggeredRead } from "#renderer/store/reads/hooks/useWindowTriggeredRead.js";
import { PushDrivenRead, type PushDrivenReadState } from "#renderer/store/reads/push-driven.js";

/** The editor list and the act that reads it again after a failed read. */
export interface EditorListBinding {
  readonly state: PushDrivenReadState<readonly EditorEntry[]>;
  readonly readAgain: () => void;
}

/** Read the editors this machine has while the caller is mounted, on the window's `clock`. */
export function useEditorList(bridge: PlatformBridge, clock: Clock): EditorListBinding {
  const { read, state } = useWindowTriggeredRead(
    bridge.transportReconnect,
    bridge,
    undefined,
    () =>
      new PushDrivenRead<readonly EditorEntry[]>({
        clock,
        origin: EDITOR_LIST_ORIGIN,
        read: () => bridge.native.listEditors(),
        subscribe: () => () => undefined,
      }),
  );
  return {
    state,
    readAgain: () => {
      read.refresh("user-request");
    },
  };
}

/** Names the editor list read in a refusal. */
const EDITOR_LIST_ORIGIN = "editor-list";
