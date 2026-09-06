// The file control: the one way a local file reaches the pane, and the disclosure
// that says where one may come from.
//
// `Spec-023 §Console Design (Meridian)` 12.2 Never: "The address field never accepts a
// filesystem path. Local files open through the file control, which runs the boundary
// check of 12.5." The address field already refuses one; this is the control it
// refuses toward, so the refusal has somewhere to send a person.
//
// THE DISCLOSURE IS A DESCRIPTION, NEVER A CHECK. `file-boundary.ts` states why at
// length: resolution and containment are facts about a disk this process cannot see,
// so the roots below are what the daemon reported and the copy says plainly that a
// path inside one can still be refused. Nothing here compares the draft against them.
// A control that greyed out its own submit on a local prediction would be the
// renderer deriving eligibility the daemon owns, and it would be wrong first for the
// symlink case — which is exactly the case the envelope exists for.
//
// AND THE REFUSAL NEVER ECHOES THE PATH. When the boundary refuses, the sentence
// beside this control names the RULE; the daemon's own message renders verbatim in
// the pane's refusal banner, and what the person typed stays in their field. The
// draft is deliberately kept on a refusal, on the address field's precedent: clearing
// it would read as the control having eaten the path, and a person correcting one
// character would have to type the whole thing again.

import { useId, useState } from "react";

import type { ConsoleRefusal } from "../../../core/index.js";
import { AdmittedRoots } from "./AdmittedRoots.js";
import { ChromeControl } from "../chrome/ChromeControl.js";
import type { BrowserChromeActs } from "../chrome/chrome-acts.js";
import { isOutsideTrustEnvelope, type AdmittedRootsReading } from "./file-boundary.js";

export interface FileControlProps {
  readonly acts: BrowserChromeActs;
  readonly roots: AdmittedRootsReading;
  /** The pane's current act refusal, read only to recognise the boundary's own. */
  readonly refusal: ConsoleRefusal | undefined;
}

export function FileControl(props: FileControlProps): React.JSX.Element {
  const { acts, roots, refusal } = props;
  const [draftPath, setDraftPath] = useState("");
  const fieldId = useId();

  return (
    <div className="meridian-browser-file">
      <form
        className="meridian-browser-file__form"
        onSubmit={(event) => {
          event.preventDefault();
          const path = draftPath.trim();
          if (path.length === 0) {
            return;
          }
          acts.openLocalFile(path);
        }}
      >
        <label htmlFor={fieldId} className="meridian-browser-file__label">
          Local file
        </label>
        <input
          id={fieldId}
          type="text"
          value={draftPath}
          placeholder="Path inside an admitted root"
          onChange={(event) => {
            setDraftPath(event.target.value);
          }}
          className="meridian-browser-file__field"
        />
        <ChromeControl
          label="Open file"
          disabled={draftPath.trim().length === 0}
          onActivate={() => {
            const path = draftPath.trim();
            if (path.length > 0) {
              acts.openLocalFile(path);
            }
          }}
        />
      </form>

      {isOutsideTrustEnvelope(refusal) ? (
        <p className="meridian-browser-file__boundary" role="status">
          That destination is outside this session&apos;s trust envelope. A local file opens only
          from inside an admitted root of a repo mount attached to this session, resolved on the
          machine that holds it.
        </p>
      ) : null}

      <AdmittedRoots reading={roots} />
    </div>
  );
}
