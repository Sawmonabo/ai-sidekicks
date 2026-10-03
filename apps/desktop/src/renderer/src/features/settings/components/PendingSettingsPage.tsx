// What a settings section renders while its page module is still loading: an empty hidden
// region carrying the pending-body marker.
//
// `SettingsPane` has already drawn the page frame and heading from the descriptor, so only the
// body is missing and the honest reservation is the empty region it will fill. None of the
// empty-state kinds fits: the page has not mounted, so it has asked the daemon for nothing. The
// marker is the one a pending pane wears, so a capture asks one question, and its value is the
// section id. It rides a `hidden` element so the region takes no layout box.

import { PENDING_BODY_ATTRIBUTE } from "@renderer/components/LazyBody/pending-body-marker.js";
import type { SettingsPageId } from "@renderer/routing/settings-page-ids.js";

/** Props for {@link PendingSettingsPage}. */
export interface PendingSettingsPageProps {
  /** The rail section whose page is loading, carried as the pending marker's value. */
  readonly section: SettingsPageId;
}

/** The settings page's reserved region, shown before its body arrives. */
export function PendingSettingsPage(props: PendingSettingsPageProps): React.JSX.Element {
  return <span hidden {...{ [PENDING_BODY_ATTRIBUTE]: props.section }} />;
}
