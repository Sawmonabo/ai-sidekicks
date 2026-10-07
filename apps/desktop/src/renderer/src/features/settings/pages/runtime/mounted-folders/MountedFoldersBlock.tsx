import type { ReactNode } from "react";

import { settingsControlAnchor } from "#renderer/features/settings/control/anchor.js";
import { RUNTIME_CONTROLS } from "../controls.js";

/**
 * The Runtime page's mounted-folders block: its frame, and whatever list the caller
 * composes under it.
 *
 * The list is `children` because it is built on calls this block does not hold.
 */
export function MountedFoldersBlock(props: { readonly children?: ReactNode }): ReactNode {
  return (
    <section
      className="meridian-settings-page__block"
      aria-label={RUNTIME_CONTROLS.foldersThisMachineCanReach.label}
      {...settingsControlAnchor(RUNTIME_CONTROLS.foldersThisMachineCanReach)}
    >
      <h3 className="meridian-settings-page__section-head">
        {RUNTIME_CONTROLS.foldersThisMachineCanReach.label}
      </h3>
      {props.children}
    </section>
  );
}
