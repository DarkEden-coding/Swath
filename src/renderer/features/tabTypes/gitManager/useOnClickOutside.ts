import { useEffect, type RefObject } from "react";

/** Closes a transient surface when an active pointer press lands outside it. */
export function useOnClickOutside(
  ref: RefObject<HTMLElement | null>,
  handler: () => void,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const onDocumentMouseDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) handler();
    };
    document.addEventListener("mousedown", onDocumentMouseDown);
    return () => document.removeEventListener("mousedown", onDocumentMouseDown);
  }, [active, handler, ref]);
}
