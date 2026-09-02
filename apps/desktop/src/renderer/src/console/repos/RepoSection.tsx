// The session sidebar's repos section — the chrome, and what it is honest about
// before a mount read exists.
//
// `Spec-023 §Console Design (Meridian)` §10.1 gives the section its job: say which
// repositories this session is attached to, on which node, and whether each is
// still the repository it was attached as. Three of that sentence's four answers
// are per-mount data, and the mount cards that carry them are built in this family
// beside this file. What this file owns is the part that does not change when they
// arrive: where the section's content sits, what it says while there is none, and
// the two rules the section obeys no matter what it is showing.
//
// A LIST, NEVER A SINGLE SLOT. `Spec-009 §Required Behavior` admits several repo
// mounts in one session, so the content region below is a list even at one member
// and even at none. A section that rendered one mount and grew a list later would
// have to move every card it had already drawn.
//
// THE SIDEBAR OWNS THE HEADER. `SidebarSectionContext.isOpen` is the sidebar's
// answer, not the section's — the rule it comes from is stated over the whole
// sidebar ("a section carrying an amber or red item is open and every other section
// is collapsed"), so a section that drew its own disclosure would be a second
// source of truth for it. This body renders its content when the sidebar says it is
// open and one quiet line when it does not, and it draws no heading, because the
// heading is the sidebar's.
//
// WHY THE ABSENCE IS `not-checked`. `empty` would assert that the session has no
// repo mounts. The console has not asked: `repo.mountRead` and `repo.workspaceList`
// are daemon methods the desktop bridge does not route yet, and the read that
// resolves this section ships with the mount cards. "We have not asked" and "there
// are none" are different facts and rule 8 exists so a console never spends the
// second when it only has the first.

import { Nothing } from "../primitives/index.js";
import { type SidebarSectionContext } from "../workspace/index.js";

export interface RepoSectionProps {
  readonly context: SidebarSectionContext;
}

/** What a collapsed section says on its one line, and what an open one says instead. */
const NOT_READ_TITLE = "Repo mounts have not been read.";

export function RepoSection(props: RepoSectionProps): React.JSX.Element {
  if (!props.context.isOpen) {
    return (
      <p className="meridian-repo-section__summary">
        <Nothing kind="not-checked" title={NOT_READ_TITLE} />
      </p>
    );
  }
  return (
    <div className="meridian-repo-section">
      {/*
        The mount list's region. Cards land inside it, one per mount, in the order
        the read returns them; the region stays where it is when they do.
      */}
      <div className="meridian-repo-section__mounts">
        <Nothing
          kind="not-checked"
          placement="surface"
          title={NOT_READ_TITLE}
          detail="Attaching a repository is deliberate — nothing is attached to a session automatically. This section will name each mount's resolved root, the node that owns it, and whether it is still the repository it was attached as."
        />
      </div>
    </div>
  );
}
