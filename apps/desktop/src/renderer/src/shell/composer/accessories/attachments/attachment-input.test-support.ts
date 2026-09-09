// The browser payloads a drop and a paste arrive as, which jsdom will not construct.
//
// Hoisted on the second use: the binding's own suite and the rail's composition suite
// both have to hand the region a file transfer, and a second copy of these two shapes
// would let one suite exercise a shape the other does not.
//
// THE STAND-IN IS THE SHAPE THE BINDING CONSUMES rather than a narrower one chosen to
// make a case pass: `types` is read to decide whether a drag carries files at all, and
// `files` is read for its `length` and then handed to `Array.from`, so an array-like
// with both is exactly as much `FileList` as this code path ever sees.

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
 * One event carrying a payload property jsdom offers no constructor for.
 *
 * Returned rather than dispatched, so a caller decides when it lands — the rail's
 * suite dispatches inside an async `act` and the binding's own suite does not.
 */
export function eventCarrying(type: string, property: string, value: unknown): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, property, { value });
  return event;
}
