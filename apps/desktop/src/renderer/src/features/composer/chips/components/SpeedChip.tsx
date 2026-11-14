// The composer's speed chip: `Fast` or `Standard` for the lead's model, a press switching the next
// turn's speed; on a model with no fast output it reads `Standard`, grayed and reported disabled,
// a press changing nothing and its hover title naming the model.

import { useSyncExternalStore } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { ComposerHeldDraft } from "../../held-draft/holder.js";
import { useLeadModel } from "../hooks/useLeadModel.js";
import { readSpeedChip } from "../speed.js";

/** What the speed chip reads and writes: the session, and the held draft holding the turn speed. */
export interface SpeedChipProps {
  readonly bridge: PlatformBridge;
  readonly sessionId: SessionId;
  readonly heldDraft: ComposerHeldDraft;
}

/** The speed chip, always drawn. */
export function SpeedChip(props: SpeedChipProps): React.JSX.Element {
  const lead = useLeadModel(props.bridge, props.sessionId);
  const held = useSyncExternalStore(props.heldDraft.subscribe, props.heldDraft.snapshot);
  const chip = readSpeedChip(
    lead.model,
    lead.levels,
    held.extras.outputSpeedForTurn ?? lead.runningLevel,
  );
  if (chip.kind === "grayed") {
    return (
      <HoverLabel text={chip.reason} textRole="description">
        <button
          type="button"
          className="meridian-composer-chip meridian-composer-chip--grayed"
          aria-disabled="true"
        >
          Standard
        </button>
      </HoverLabel>
    );
  }
  return (
    <button
      type="button"
      className="meridian-composer-chip"
      onClick={() => {
        props.heldDraft.setOutputSpeedForTurn(
          chip.word === "Fast" ? chip.standardLevel : chip.fastLevel,
        );
      }}
    >
      {chip.word}
    </button>
  );
}
