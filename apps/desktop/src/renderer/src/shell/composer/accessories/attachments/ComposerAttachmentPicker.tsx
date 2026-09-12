// Choosing a file, and saying what will be accepted before anyone chooses one.
//
// THE HINT IS ON THE PICKER: the allow-list and all four bounds are one click from the
// control that opens a file dialog, rather than complete on a pane a person would have
// to go and find. The disclosure is the repos family's own component taken through its
// door — two surfaces rendering two lists would be two answers about a deployment
// neither of them can see.
//
// AND THE LIST IS SHOWN, NEVER ENFORCED. There is deliberately no `accept` attribute on
// the input below. An operator override REPLACES the shipped list wholesale, so filtering
// the dialog by the list this console happens to hold would hide files the daemon would
// have admitted — the console enforcing a hint, which is the one thing the hint is not.
// The dialog offers everything; the daemon refuses what it refuses, by name.
//
// THE INPUT IS THE CONTROL, not a button that clicks a hidden input. A real file input
// inside its own label announces as one control, takes the keyboard without any help,
// and needs no ref: the visually-hidden class hides it from sight and from nothing else.
//
// THE VALUE IS CLEARED AFTER EVERY CHOICE. Without that, choosing the same file twice in
// a row fires no second change event — the browser compares against the input's current
// value — so a person whose first upload was refused could not retry by re-choosing it.

import {
  AttachmentBoundsDisclosure,
  SHIPPED_DEFAULT_ALLOWLIST,
} from "../../../../console/repos/index.js";

export interface ComposerAttachmentPickerProps {
  /** Where the chosen files go. Called with at least one file, never with none. */
  readonly onFilesChosen: (files: readonly File[]) => void;
}

export function ComposerAttachmentPicker(props: ComposerAttachmentPickerProps): React.JSX.Element {
  return (
    <div className="meridian-composer-picker">
      <label className="meridian-composer-picker__control">
        <span className="meridian-composer-picker__label">Attach files</span>
        <input
          type="file"
          multiple
          className="meridian-visually-hidden"
          onChange={(event) => {
            const chosen = event.target.files;
            if (chosen !== null && chosen.length > 0) {
              props.onFilesChosen(Array.from(chosen));
            }
            event.target.value = "";
          }}
        />
      </label>
      {/* The shipped default, named as such by the component itself. This affordance
          reads no effective list: `bridge/growth-port/growth-port.ts` refuses
          `artifactAllowlistRead` on every build the console can run on today, so a
          second reader here would be a second refusal on screen for a value that
          would come back as this same default in every reachable state. */}
      <AttachmentBoundsDisclosure allowlist={SHIPPED_DEFAULT_ALLOWLIST} />
    </div>
  );
}
