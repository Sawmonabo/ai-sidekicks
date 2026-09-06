// Where local files may come from, in the daemon's own words.
//
// Its own module for `apps/desktop/AGENTS.md`'s one-component rule, and the split
// lands cleanly because the two components answer different questions: the control
// beside it takes a path and dispatches, and this one only DESCRIBES the envelope
// that path will be checked against.
//
// IT IS A DESCRIPTION AND NEVER A CHECK. `file-boundary.ts` states why at length:
// resolution and containment are facts about a disk this process cannot see, so these
// roots are what the daemon reported and the copy says plainly that a path inside one
// can still be refused. Nothing here compares a draft against them.

import { InlineRefusal, Nothing, WireFigure } from "../../primitives/index.js";
import type { AdmittedRootsReading } from "./file-boundary.js";

/**
 * Where files may come from, in the daemon's own words, with its own absences.
 *
 * Four arms, and the two that are not a list are the point: a session whose
 * workspaces have not been read yet is not a session with no admitted roots, and a
 * read that was refused is not an empty envelope. Rendering either as "no roots"
 * would tell a person local files are impossible here when nothing has said so.
 */
export function AdmittedRoots(props: {
  readonly reading: AdmittedRootsReading;
}): React.JSX.Element {
  const { reading } = props;
  if (reading.kind === "reading") {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title="Admitted roots not read"
        detail="Where local files may come from has not been read for this session."
      />
    );
  }
  if (reading.kind === "refused") {
    return <InlineRefusal {...reading.refusal} />;
  }
  if (reading.roots.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="No admitted roots"
        detail="No workspace attached to this session reported a filesystem root, so there is nowhere a local file can be admitted from."
      />
    );
  }
  return (
    <div className="meridian-browser-file__roots">
      <p className="meridian-browser-file__roots-lead">
        A local file is admitted only from inside one of these, and the check runs where the files
        are — a path inside one can still be refused.
      </p>
      <ul>
        {reading.roots.map((root) => (
          <li key={root}>
            <WireFigure value={root} />
          </li>
        ))}
      </ul>
      {reading.unreportedWorkspaceCount > 0 ? (
        <p className="meridian-browser-file__roots-note">
          {reading.unreportedWorkspaceCount === 1
            ? "One more workspace is attached and reported no filesystem root, so this list is not the whole envelope."
            : `${String(reading.unreportedWorkspaceCount)} more workspaces are attached and reported no filesystem root, so this list is not the whole envelope.`}
        </p>
      ) : null}
    </div>
  );
}
