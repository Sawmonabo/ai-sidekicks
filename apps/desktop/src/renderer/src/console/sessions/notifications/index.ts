// The notifications subtree's door.
//
// One surface — the notification center the sessions destination mounts — over one
// vocabulary, the attention plane. The stylesheet is imported here and nowhere
// else, so a surface can never render the center without it and the bundler sees
// one edge into the sheet.
//
// A SUB-MODULE of the sessions family rather than a family of its own. Both of the
// plane's consumers are that family's — the all-sessions list reads it for a row's
// severity, and the center it mounts reads it for the grouping — so the two sit in
// one family and this door publishes to it. It sat beside `sessions/` until the
// layering gate said what that was: view families are siblings, and one importing
// another is an edge no ordering untangles. A second consumer in another family
// hoists the vocabulary into `seats/` rather than moving this door back out.
//
// WHAT IS AND IS NOT AN EMISSION PATH HERE. `attention.notificationEmit` is a
// control-plane mutation the daemon calls and never a client method, and nothing in
// this subtree reaches for it. `native.showNotification` is a different thing: it is
// the shipped bridge's own member and this subtree is its one caller, under
// `attention-notifier.ts`' when-rule. What stays main-process-owned is the CLICK —
// the call returns `void`, so the renderer cannot observe one — and the permission
// behind it, which no bridge member reports and which therefore reaches the centre
// through the growth port.

import "./notifications.css";

export { NotificationCenter } from "./NotificationCenter.js";

// Only what crosses OUT of this subtree. The plane's vocabulary, its narrowing,
// and the fold are reached deeply from inside — an intra-subtree import is deep by
// the layout rule, and a barrel re-exporting a symbol nobody outside it imports is
// a door onto a room with no other entrance.
export { type AttentionReading } from "./attention-plane.js";
export { attentionProjectionReaderFor } from "./attention-projection-read.js";
// The read's own lifetime lives next door: the plane is a vocabulary and a fold, and
// the hook that performs the read and keeps it current is what a destination mounts.
export { useAttentionProjection, useAttentionSettlementAnnouncement } from "./attention-read.js";

// The emission path and the fact that decides whether it reaches anyone. Both leave
// through this door because the window's attention binding mounts them for the frame's
// lifetime and provides the reading on to the centre; the notifier's own class stays
// inside, since only its hook is mounted. The type leaves with them, because the
// binding publishes the reading on its own context value.
export { useAttentionNotifications } from "./attention-notifier.js";
export {
  useOsNotificationDelivery,
  type OsNotificationDelivery,
} from "./os-notification-delivery.js";
export { useRailAttentionPublisher } from "./rail-attention.js";
