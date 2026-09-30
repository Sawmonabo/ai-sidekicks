// The settings feature's bound: how many mounts an inventory reads in full.

/**
 * Mounts a settings inventory reads in full before it stops naming them.
 *
 * The inventory costs one workspace-list call plus one mount read per distinct mount.
 * Twenty-four is far above any session a person assembles by hand and bounds the fan-out.
 * Past it the page names how many mounts it did not read, because a silently truncated
 * inventory is worse than a long one.
 */
export const MOUNT_INVENTORY_READ_CAP = 24;
