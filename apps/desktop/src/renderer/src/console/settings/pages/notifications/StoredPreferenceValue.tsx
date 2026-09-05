import { type ReactNode } from "react";
import { WireFigure } from "../../../primitives/index.js";
import { type PreferenceRow } from "./attention-preference-model.js";
import { PreferenceToggleRow } from "../../shared/PreferenceToggleRow.js";
import type { ConsoleRefusal } from "../../../core/index.js";
import {
  type AttentionPreferenceReadOutcome,
  type CallerParticipantOutcome,
  type PreferenceToggleMember,
} from "./attention-preference-model.js";
import { type TogglePreferenceRow } from "./notification-preference-writer.js";

/** One stored value: switches where the rule allows it, and reading where it does not. */
export function StoredPreferenceValue(props: {
  readonly row: PreferenceRow;
  readonly binding: StoredPreferenceBinding;
}): ReactNode {
  const { row, binding } = props;
  if (row.kind === "opaque") {
    return (
      <p className="meridian-attention-preferences__opaque">
        <WireFigure value={row.rendering} />
      </p>
    );
  }
  const isBusy = binding.isRecordBusy(row.key);
  return (
    <>
      {row.members.map((member) => (
        <PreferenceToggleRow
          key={member.memberKey}
          label={member.name}
          description={STORED_MEMBER_DESCRIPTION}
          checked={member.isEnabled}
          isPending={isBusy}
          refusal={binding.refusalFor(member.memberKey)}
          onCheckedChange={() => {
            binding.toggleMember(row, member);
          }}
        />
      ))}
    </>
  );
}

/** What one preference edit is doing right now: busy per record, refused per switch. */
export interface StoredPreferenceBinding {
  readonly participantOutcome: CallerParticipantOutcome | undefined;
  readonly readOutcome: AttentionPreferenceReadOutcome | undefined;
  /** True while any switch in this record has a write out or queued behind one. */
  readonly isRecordBusy: (recordKey: string) => boolean;
  readonly refusalFor: (memberKey: string) => ConsoleRefusal | undefined;
  readonly toggleMember: (row: TogglePreferenceRow, member: PreferenceToggleMember) => void;
}

/**
 * What every stored switch says about itself.
 *
 * The same sentence under every member because it is the same fact about every one
 * of them: this console was told the member exists and was not told what it governs.
 * A per-member sentence would be copy invented for a key nothing has named.
 */
export const STORED_MEMBER_DESCRIPTION =
  "Shown exactly as the daemon stores it. Nothing here says what it governs.";
