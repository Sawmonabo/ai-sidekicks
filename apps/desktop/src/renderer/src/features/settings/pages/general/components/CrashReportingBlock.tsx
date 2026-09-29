// The crash-reporting block's frame: the section and its heading.

import type { ReactNode } from "react";

/**
 * The crash-reporting block: a section carrying only its heading.
 *
 * @consumedBy the General settings page's crash-reporting block
 */
export function CrashReportingBlock(): ReactNode {
  return (
    <section className="meridian-settings-page__block" aria-label="Crash reporting">
      <h3 className="meridian-settings-page__block-title">Crash reporting</h3>
    </section>
  );
}
