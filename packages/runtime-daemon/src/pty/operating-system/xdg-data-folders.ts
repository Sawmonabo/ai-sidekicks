// The data folders the XDG Base Directory specification sets for `XDG_DATA_DIRS` when it is unset
// or empty, which every system that follows the specification shares.

/** The default `XDG_DATA_DIRS`, in the order a program reads them. */
export const XDG_DEFAULT_DATA_FOLDERS: readonly string[] = ["/usr/local/share", "/usr/share"];
