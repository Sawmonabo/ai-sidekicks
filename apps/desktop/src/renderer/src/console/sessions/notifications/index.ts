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
// What is deliberately NOT here: any emission path. `attention.notificationEmit`
// is a control-plane mutation the daemon calls and never a client method, and
// `native.showNotification` is the shell's — the renderer cannot observe a click
// through a `void` return, so click routing is main-process-owned by construction.

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
export { useRailAttentionPublisher } from "./rail-attention.js";
