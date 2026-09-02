// Where the composer is addressed, resolved once from the store and the focused pane.
//
// A hook rather than a derivation in a render body, per this package's structure
// rules: the resolution reads three store partitions, and a component that read them
// inline would re-derive on every render of every zone that needed the answer.
// `useMemo` over the three partition references is exact — the store merges
// immutably, so an untouched partition keeps its identity and the memo is a pointer
// comparison rather than a deep one.
//
// BOTH ZONES CALL IT. The chip rail renders the address and the send bar acts on it,
// and they are separate zones behind separate barrels so separate lanes can fill
// them. Calling one hook twice is one implementation with two readers; handing the
// answer down from the host would have made the host know what both zones are for.

import { useMemo } from "react";

import { useSessionPartition, type SessionStore } from "../../console/store/index.js";
import type { ConsolePaneAddress } from "../../console/workspace/index.js";
import {
  resolveComposerTarget,
  resolvePostureChipModel,
  resolveTargetChipModel,
  type ComposerTarget,
  type PostureChipModel,
  type TargetChipModel,
} from "./chips/chip-models.js";

/** Everything the composer's zones read off one address. */
export interface ComposerAddress {
  readonly target: ComposerTarget;
  readonly targetChip: TargetChipModel;
  readonly postureChip: PostureChipModel;
}

/** Resolve the composer's address within one session. */
export function useComposerAddress(
  sessionStore: SessionStore,
  focusedPane: ConsolePaneAddress | undefined,
): ComposerAddress {
  const agents = useSessionPartition(sessionStore, "agent");
  const runs = useSessionPartition(sessionStore, "run");
  const channels = useSessionPartition(sessionStore, "channel");
  const sessionId = sessionStore.sessionId;
  return useMemo(() => {
    const target = resolveComposerTarget({ sessionId, focusedPane, agents, runs, channels });
    return {
      target,
      targetChip: resolveTargetChipModel(target, agents),
      postureChip: resolvePostureChipModel(target, runs),
    };
  }, [sessionId, focusedPane, agents, runs, channels]);
}
