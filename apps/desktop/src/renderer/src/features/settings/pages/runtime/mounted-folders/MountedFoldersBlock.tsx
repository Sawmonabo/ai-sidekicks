import type { ReactNode } from "react";
import type { SettingsPageRegistry } from "../../../settings-pages.js";

/** The owner recorded for this page, so an unfilled section names someone. */
const OWNER = "settings-mounts";

/**
 * The mounts page: its frame, and whatever inventory the caller composes under it.
 *
 * The inventory is `children` because it is built on calls this page does not hold.
 */
export function WorkspaceMountsPage(props: { readonly children?: ReactNode }): ReactNode {
  return (
    <div className="meridian-settings-page">
      <section className="meridian-settings-page__block" aria-label="Mounted repositories">
        <h3 className="meridian-settings-page__block-title">Mounted repositories</h3>
        {props.children}
      </section>
    </div>
  );
}

/** Claim the mounts section. */
export function registerWorkspaceMountsPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "mounts",
    owner: OWNER,
    label: "Workspace mounts",
    keywords: ["repository", "repo", "worktree", "workspace", "path", "checkout", "clone"],
    render: () => <WorkspaceMountsPage />,
  });
}
