// Every state the two-read chain can be in, and what each one renders.
//
// TWO OF THOSE STATES CHANGED, AND BOTH FOR THE SAME REASON: a page that says nothing
// is a page a person cannot use.
//
//   • **Nothing stored is not nothing to show.** The empty arm used to be a sentence
//     and no controls, which inverts the surface — an empty store is exactly the state
//     a person arrives in, and the one where they most need a switch. Every trigger the
//     daemon holds no record for now renders at its default, tagged as a default, and
//     flipping one writes it. The tag is what keeps the two facts apart: a default
//     drawn without one reads as the person's own answer.
//
//   • **A re-read does not blank the rows.** The set is re-read when the window comes
//     back, and the reading is held beside the in-flight flag rather than replaced by
//     it, so what is on screen stays there and goes unpressable while the answer is
//     refreshed. Returning to "Reading your preferences." on every focus would read as
//     the console forgetting.

import { type ReactNode } from "react";
import { Chip, InlineRefusal, Nothing, WireFigure } from "../../../primitives/index.js";
import { projectPreferenceRows } from "./attention-preference-model.js";
import { preferencesWithDefaults } from "./default-preferences.js";
import { StoredPreferenceValue } from "./StoredPreferenceValue.js";
import { type StoredPreferenceBinding } from "./StoredPreferenceValue.js";

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
  if (binding.participantReading === undefined) {
    return <Nothing kind="not-loaded" placement="surface" title="Finding out who you are." />;
  }
  // Two refusals, one shape. A port that answered `unavailable` and a call that
  // produced no answer at all are the same thing to a person reading the page —
  // nothing was asked of the preference store and no participant was guessed to ask
  // with — and they stay apart in the value because only one is the port speaking.
  if (binding.participantReading.kind === "unreadable") {
    return <InlineRefusal {...binding.participantReading.refusal} />;
  }
  if (binding.participantReading.outcome.status === "unavailable") {
    return (
      <InlineRefusal
        code={binding.participantReading.outcome.code}
        detail={binding.participantReading.outcome.detail}
      />
    );
  }
  if (binding.preferenceReading === undefined) {
    return <Nothing kind="not-loaded" placement="surface" title="Reading your preferences." />;
  }
  if (binding.preferenceReading.kind === "unreadable") {
    return <InlineRefusal {...binding.preferenceReading.refusal} />;
  }
  if (binding.preferenceReading.outcome.status === "unavailable") {
    return (
      <InlineRefusal
        code={binding.preferenceReading.outcome.code}
        detail={binding.preferenceReading.outcome.detail}
      />
    );
  }
  const stored = preferencesWithDefaults(binding.preferenceReading.outcome.value.preferences);
  const rows = projectPreferenceRows(stored.preferences);
  return (
    <ul className="meridian-attention-preferences" aria-busy={binding.isReadInFlight}>
      {rows.map((row) => (
        // `aria-busy` on the RECORD rather than on one switch, because that is the
        // scope the write locks: the value goes back whole, so every member of it is
        // unpressable until the daemon answers. The list carries its own for the
        // re-read, which locks every record at once and replaces none of them.
        <li
          className="meridian-attention-preferences__row"
          key={row.key}
          aria-busy={binding.isRecordBusy(row.key)}
        >
          <p className="meridian-attention-preferences__key">
            <WireFigure value={row.key} />
            {stored.defaultedKeys.has(row.key) ? (
              <Chip tone="neutral" label="default" glyph="dot" />
            ) : null}
          </p>
          <StoredPreferenceValue
            row={row}
            binding={binding}
            isDefault={stored.defaultedKeys.has(row.key)}
          />
        </li>
      ))}
    </ul>
  );
}
