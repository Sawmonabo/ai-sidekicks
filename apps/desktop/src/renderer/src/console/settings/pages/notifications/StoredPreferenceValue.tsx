import { type ReactNode } from "react";
import { WireFigure } from "../../../primitives/index.js";
import { type PreferenceRow } from "./attention-preference-model.js";
import { PreferenceToggleRow } from "../../shared/PreferenceToggleRow.js";
import { STORED_MEMBER_DESCRIPTION, type StoredPreferenceBinding } from "./NotificationsPage.js";

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
