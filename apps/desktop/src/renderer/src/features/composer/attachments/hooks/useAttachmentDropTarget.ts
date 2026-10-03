// Drop and paste of files over the whole composer region, both handing the staged list the
// same `File[]`. A paste with no file is left alone, since the message input lives inside the
// region and `preventDefault()` on every paste would break pasting text. Enter and leave are
// counted because `dragleave` also fires when the pointer crosses an inner child.

import { useCallback, useEffect, useRef, useState } from "react";

import { useLatestRef } from "@renderer/hooks/useLatestRef.js";

/** Options for `useAttachmentDropTarget`. */
export interface AttachmentDropOptions {
  /** The composer region, supplied by the host that owns it. */
  readonly region: React.RefObject<HTMLElement | null>;
  /** Where the chosen files go. Called with at least one file, never with none. */
  readonly onFilesChosen: (files: readonly File[]) => void;
}

/**
 * The transfer type a browser declares when a drag carries files. `DataTransfer.files` is
 * empty during `dragover` by design, so the type is what lets a drag be recognized and
 * `preventDefault()` keep the window from navigating to the dropped file.
 */
const FILE_TRANSFER_TYPE = "Files";

/**
 * Bind file drop and paste over one region. Returns whether a file drag is currently over it.
 */
export function useAttachmentDropTarget(options: AttachmentDropOptions): boolean {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  // Listeners are bound once per region, so they read the newest handler through a ref;
  // re-binding on a caller's inline arrow would tear down a live drag.
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
      // Without the prevented default the browser treats the region as a non-target, and
      // without the effect the pointer shows a "move" cursor.
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
      // Prevented even when the transfer carries no files, or the window navigates away to
      // render whatever was dropped.
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
      deliver(event.dataTransfer?.files);
    };
    const onPaste = (event: ClipboardEvent): void => {
      // The default is left alone unless files traveled, so pasting text still works.
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
