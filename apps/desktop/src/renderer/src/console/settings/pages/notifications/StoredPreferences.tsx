import { type ReactNode } from "react";
import { InlineRefusal, Nothing, WireFigure } from "../../../primitives/index.js";
import { projectPreferenceRows } from "./attention-preference-model.js";
import { StoredPreferenceValue } from "./StoredPreferenceValue.js";
import { type StoredPreferenceBinding } from "./StoredPreferenceValue.js";

/** Every state the two-read chain can be in, and what each one renders. */
export function StoredPreferences(props: {
  readonly binding: StoredPreferenceBinding;
  readonly hasSession: boolean;
}): ReactNode {
  const { binding } = props;
  if (!props.hasSession) {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="Your preferences have not been read yet."
        detail="Reading them starts with knowing which participant you are, and this window has opened no session to resolve one from. Nothing was asked — so nothing here is a reading, and a default would look like your answer."
      />
    );
  }
  if (binding.participantOutcome === undefined) {
    return <Nothing kind="not-loaded" placement="surface" title="Finding out who you are." />;
  }
  if (binding.participantOutcome.status === "unavailable") {
    // The chain's own refusal, rendered where the set would have been: nothing was
    // asked of the preference store, and no participant was guessed to ask with.
    return (
      <InlineRefusal
        code={binding.participantOutcome.code}
        detail={binding.participantOutcome.detail}
      />
    );
  }
  if (binding.readOutcome === undefined) {
    return <Nothing kind="not-loaded" placement="surface" title="Reading your preferences." />;
  }
  if (binding.readOutcome.status === "unavailable") {
    return <InlineRefusal code={binding.readOutcome.code} detail={binding.readOutcome.detail} />;
  }
  const rows = projectPreferenceRows(binding.readOutcome.value.preferences);
  if (rows.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="The daemon holds no preference for you yet."
        detail="Nothing is stored under your name, and nothing is assumed in its place."
      />
    );
  }
  return (
    <ul className="meridian-attention-preferences">
      {rows.map((row) => (
        // `aria-busy` on the RECORD rather than on one switch, because that is the
        // scope the write locks: the value goes back whole, so every member of it is
        // unpressable until the daemon answers.
        <li
          className="meridian-attention-preferences__row"
          key={row.key}
          aria-busy={binding.isRecordBusy(row.key)}
        >
          <p className="meridian-attention-preferences__key">
            <WireFigure value={row.key} />
          </p>
          <StoredPreferenceValue row={row} binding={binding} />
        </li>
      ))}
    </ul>
  );
}
