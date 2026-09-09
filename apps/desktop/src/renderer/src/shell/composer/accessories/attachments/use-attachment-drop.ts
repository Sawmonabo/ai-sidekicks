// The two ways a file reaches the composer without anyone opening a picker.
//
// ONE BINDING FOR BOTH, because they are one act with two gestures: a person drops a
// file on the message they are writing, or pastes one into it, and either way the
// carrier is handed the same `File[]`. Two hooks would be two places to get the
// guard wrong.
//
// THE REGION IS THE WHOLE COMPOSER AND NOT A DROP STRIP. A target a person has to aim
// at is a target they miss, and the composer is already the region the host owns and
// hands to the surfaces that need it — the discovery popover takes the same ref for
// the same reason. What is bound to it is deliberately narrow: this reads a drag's
// declared types and a paste's file list and nothing else about either event.
//
// AND A PASTE WITH NO FILE IS LEFT ALONE, which is the guard that matters most. The
// message input lives inside this same region, so a hook that called
// `preventDefault()` on every paste would have quietly broken pasting text into the
// composer — the single most common thing anyone does there. The default is untouched
// unless the clipboard actually carries files.
//
// THE COUNTER IS WHY `dragleave` IS NOT ENOUGH ON ITS OWN. Dragging across a child
// element fires `dragleave` on the way out of it, so a flag flipped on that event
// alone reports the drag as over the moment the pointer crosses any inner boundary.
// Enter and leave are counted instead, and the highlight clears at zero.

import { useCallback, useEffect, useRef, useState } from "react";

import { useLatestRef } from "../../../../console/primitives/index.js";

/** What a drop-and-paste binding needs, and what it hands back. */
export interface AttachmentDropOptions {
  /** The composer region, supplied by the host that owns it. */
  readonly region: React.RefObject<HTMLElement | null>;
  /** Where the chosen files go. Called with at least one file, never with none. */
  readonly onFilesChosen: (files: readonly File[]) => void;
}

/**
 * The transfer type a browser declares when a drag carries files.
 *
 * Read rather than inferred from the item list, because `DataTransfer.files` is empty
 * during a `dragover` by design — the browser withholds the payload until the drop —
 * so a binding that waited to see files would never highlight and would never call
 * `preventDefault()`, which is what makes the drop land here rather than navigating
 * the window to the dropped file.
 */
const FILE_TRANSFER_TYPE = "Files";

/**
 * Bind drop and paste over one region.
 *
 * Returns whether a file drag is currently over it, which is the only state a caller
 * renders from. Nothing else about the drag is exposed: what is being dragged is the
 * operating system's business until it lands.
 */
export function useAttachmentDropTarget(options: AttachmentDropOptions): boolean {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  // The listeners below are bound once per region and outlive any particular render,
  // so they read the newest handler through a ref rather than closing over the one
  // that happened to be current when they were attached. Re-binding on every change
  // of a caller's inline arrow would tear down a live drag.
  const onFilesChosenRef = useLatestRef(options.onFilesChosen);
  // Nested `dragenter` / `dragleave` pairs, counted rather than flagged.
  const dragDepthRef = useRef(0);
  const { region } = options;

  const deliver = useCallback(
    (files: FileList | null | undefined): boolean => {
      if (files === null || files === undefined || files.length === 0) {
        return false;
      }
      onFilesChosenRef.current(Array.from(files));
      return true;
    },
    [onFilesChosenRef],
  );

  useEffect(() => {
    const element = region.current;
    if (element === null) {
      return;
    }
    const carriesFiles = (transfer: DataTransfer | null): boolean =>
      transfer !== null && transfer.types.includes(FILE_TRANSFER_TYPE);

    const onDragEnter = (event: DragEvent): void => {
      if (!carriesFiles(event.dataTransfer)) {
        return;
      }
      dragDepthRef.current += 1;
      setIsDraggingFiles(true);
    };
    const onDragOver = (event: DragEvent): void => {
      if (!carriesFiles(event.dataTransfer)) {
        return;
      }
      // Both halves are required for a drop to reach this window at all: without the
      // prevented default the browser treats the region as a non-target, and without
      // the effect the pointer shows a "move" cursor for something nothing is moving.
      event.preventDefault();
      if (event.dataTransfer !== null) {
        event.dataTransfer.dropEffect = "copy";
      }
    };
    const onDragLeave = (event: DragEvent): void => {
      if (!carriesFiles(event.dataTransfer)) {
        return;
      }
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDraggingFiles(false);
      }
    };
    const onDrop = (event: DragEvent): void => {
      if (!carriesFiles(event.dataTransfer)) {
        return;
      }
      // Prevented unconditionally on a file drag, including the case where the
      // transfer turns out to carry none: the alternative is the window navigating
      // away from the console to render whatever was dropped.
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
      deliver(event.dataTransfer?.files);
    };
    const onPaste = (event: ClipboardEvent): void => {
      // The default is left alone unless files actually travelled, so pasting text
      // into the message line behaves exactly as it did before this binding existed.
      if (deliver(event.clipboardData?.files)) {
        event.preventDefault();
      }
    };

    element.addEventListener("dragenter", onDragEnter);
    element.addEventListener("dragover", onDragOver);
    element.addEventListener("dragleave", onDragLeave);
    element.addEventListener("drop", onDrop);
    element.addEventListener("paste", onPaste);
    return () => {
      element.removeEventListener("dragenter", onDragEnter);
      element.removeEventListener("dragover", onDragOver);
      element.removeEventListener("dragleave", onDragLeave);
      element.removeEventListener("drop", onDrop);
      element.removeEventListener("paste", onPaste);
      dragDepthRef.current = 0;
    };
  }, [deliver, region]);

  return isDraggingFiles;
}
