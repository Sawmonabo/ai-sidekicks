// The browser payloads a drop and a paste arrive as, which jsdom will not construct. Shared so
// both suites exercise the same shapes: `types` decides whether a drag carries files, and `files`
// is read for its `length` and passed to `Array.from`, so an array-like with both is enough.

/** An array-like standing in for `FileList`. */
export function fileListOf(files: readonly File[]): FileList {
  const list: Record<number, File> & { length: number } = { length: files.length };
  files.forEach((file, index) => {
    list[index] = file;
  });
  return list as unknown as FileList;
}

/** A drag or drop declaring that it carries files. */
export function fileTransferOf(files: readonly File[]): DataTransfer {
  return {
    types: ["Files"],
    files: fileListOf(files),
    dropEffect: "none",
  } as unknown as DataTransfer;
}

/**
 * One event carrying a payload property jsdom offers no constructor for. Returned rather than
 * dispatched, so the caller decides when it lands.
 */
export function eventCarrying(type: string, property: string, value: unknown): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, property, { value });
  return event;
}
