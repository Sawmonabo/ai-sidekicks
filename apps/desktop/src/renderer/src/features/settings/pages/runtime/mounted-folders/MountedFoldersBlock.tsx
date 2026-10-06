import type { ReactNode } from "react";

/**
 * The Runtime page's mounted-folders block: its frame, and whatever list the caller
 * composes under it.
 *
 * The list is `children` because it is built on calls this block does not hold.
 */
export function MountedFoldersBlock(props: { readonly children?: ReactNode }): ReactNode {
  return (
    <section className="meridian-settings-page__block" aria-label="Mounted repositories">
      <h3 className="meridian-settings-page__section-head">Mounted repositories</h3>
      {props.children}
    </section>
  );
}
