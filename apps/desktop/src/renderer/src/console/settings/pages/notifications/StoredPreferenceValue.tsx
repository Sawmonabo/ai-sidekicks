import { type ReactNode } from "react";
import { WireFigure } from "../../../primitives/index.js";
import { type PreferenceRow } from "./attention-preference-model.js";
import { PreferenceToggleRow } from "../../shared/PreferenceToggleRow.js";
import type { ConsoleRefusal } from "../../../core/index.js";
import {
  type AttentionPreferenceReading,
  type CallerParticipantReading,
  type PreferenceToggleMember,
} from "./attention-preference-model.js";
import { type TogglePreferenceRow } from "./notification-preference-writer.js";

/** One stored value: switches where the rule allows it, and reading where it does not. */
export function StoredPreferenceValue(props: {
  readonly row: PreferenceRow;
  readonly binding: StoredPreferenceBinding;
  /** True where this console supplied the record rather than reading one. */
  readonly isDefault: boolean;
}): ReactNode {
  const { row, binding } = props;
  if (row.kind === "opaque") {
    return (
      <p className="meridian-attention-preferences__opaque">
        <WireFigure value={row.rendering} />
      </p>
    );
  }
  // Unpressable while this record's own write is out, and while the whole set is being
  // re-read: a switch pressed against a value the daemon is about to replace would
  // compose its flip from a record that is already stale.
  const isBusy = binding.isRecordBusy(row.key) || binding.isReadInFlight;
  return (
    <>
      {row.members.map((member) => (
        <PreferenceToggleRow
          key={member.memberKey}
          label={member.name}
          description={props.isDefault ? DEFAULTED_MEMBER_DESCRIPTION : STORED_MEMBER_DESCRIPTION}
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
  readonly participantReading: CallerParticipantReading | undefined;
  readonly preferenceReading: AttentionPreferenceReading | undefined;
  /** True while the set is being read again. The rows stay; they stop taking presses. */
  readonly isReadInFlight: boolean;
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

/**
 * What a switch nobody has stored says about itself.
 *
 * It says two things and both matter: that this is the console's default rather than a
 * reading, and that pressing it is what makes it an answer. A default drawn under the
 * stored sentence would claim the daemon holds a record it does not.
 */
export const DEFAULTED_MEMBER_DESCRIPTION =
  "Nobody has stored a preference for this yet, so the console shows its default. Changing it saves your answer.";
