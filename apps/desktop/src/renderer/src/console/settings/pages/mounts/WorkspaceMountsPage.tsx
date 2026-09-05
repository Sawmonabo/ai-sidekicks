import type { ReactNode } from "react";
import { Nothing } from "../../../primitives/index.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../../settings-page-registry.js";
import "./mounts.css";
import { MountInventoryList } from "./MountInventoryList.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-mounts";

export function WorkspaceMountsPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const { bridge, retainedSessionId, retainedSessionStore } = props.context;
  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        A mount is a repository this session has bound to a machine. Every mount keeps two readings
        that are not the same question — where it is in its own lifecycle, and whether the path was
        reachable the last time somebody looked — and both are shown, because a mount can be
        perfectly attached and completely unreachable.
      </p>

      <section className="meridian-settings-page__block" aria-label="Mounted repositories">
        <h3 className="meridian-settings-page__block-title">Mounted repositories</h3>
        {retainedSessionId === undefined ? (
          <Nothing
            kind="empty"
            placement="surface"
            title="Mounts belong to a session, and this window has opened none."
            detail="Open a session from the Sessions list and the repositories it has mounted render here. Nothing was asked of this machine for a session nobody has opened."
          />
        ) : (
          <MountInventoryList
            bridge={bridge}
            sessionId={retainedSessionId}
            sessionStore={retainedSessionStore}
          />
        )}
      </section>

      <section className="meridian-settings-page__block" aria-label="Managing a mount">
        <h3 className="meridian-settings-page__block-title">Managing a mount</h3>
        <div className="meridian-settings-page__prose">
          <p>
            Attaching a repository, retiring one, and disposing of its working copies all belong to
            the workspace surface rather than to settings — this page is the inventory, not the
            controls. There is deliberately no detach here: detaching cascades through every
            workspace built on the mount, and a settings row is the wrong place to start something
            that large.
          </p>
        </div>
        <Nothing
          kind="not-checked"
          placement="inline"
          title="This console has nowhere to open a mount yet."
          detail="The surface that manages one mount has not been built here, so no row offers to open it. Nothing was asked, and no control is drawn that would lead nowhere."
        />
      </section>
    </div>
  );
}

/** Claim the mounts section. See `RuntimeNodesPage.tsx` on the seam's shape. */
export function registerWorkspaceMountsPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "mounts",
    owner: OWNER,
    label: "Workspace mounts",
    keywords: ["repository", "repo", "worktree", "workspace", "path", "checkout", "clone"],
    render: (context) => <WorkspaceMountsPage context={context} />,
  });
}
