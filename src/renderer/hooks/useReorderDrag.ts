import { useCallback, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";

export type ReorderAxis = "horizontal" | "vertical";

export interface UseReorderDragOptions {
  /** Direction in which insertion points are measured. */
  axis: ReorderAxis;
  /** Current number of reorderable items. */
  itemCount: number;
  /** Returns the rendered item elements in their visual order. */
  getElements: () => readonly HTMLElement[];
  /** Resolves a transferred stable id to its current index. */
  findIndexById: (id: string) => number;
  /** Persists a move expressed as final (not insertion) indices. */
  onMove: (fromIndex: number, toIndex: number) => void;
}

export interface ReorderDragBindings {
  draggedId: string | null;
  dropIndex: number | null;
  setDropIndex: (index: number | null) => void;
  getDropIndex: (clientCoordinate: number) => number;
  finishDrag: () => void;
  startNativeDrag: (event: DragEvent, id: string, initialIndex: number) => void;
  handleNativeDragOver: (event: DragEvent) => void;
  handleNativeDrop: (event: DragEvent) => void;
  moveById: (id: string | null, insertionIndex: number) => void;
  startPointerDrag: (event: ReactMouseEvent, id: string) => void;
}

/**
 * Shares reorder gesture mechanics while leaving item markup and indicators to
 * the caller. Supports HTML drag-and-drop and a mouse fallback after a 5px
 * threshold (needed by draggable regions in the Electron shell).
 */
export function useReorderDrag(options: UseReorderDragOptions): ReorderDragBindings {
  const { axis, itemCount, getElements, findIndexById, onMove } = options;
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const getDropIndex = useCallback(
    (coordinate: number): number => {
      const hovered = getElements().findIndex((element) => {
        const rect = element.getBoundingClientRect();
        return (
          coordinate <
          (axis === "horizontal" ? rect.left + rect.width / 2 : rect.top + rect.height / 2)
        );
      });
      return hovered === -1 ? itemCount : hovered;
    },
    [axis, getElements, itemCount],
  );

  const finishDrag = useCallback((): void => {
    setDraggedId(null);
    setDropIndex(null);
  }, []);

  const moveById = useCallback(
    (id: string | null, insertionIndex: number): void => {
      const fromIndex = id === null ? -1 : findIndexById(id);
      if (fromIndex !== -1) {
        const toIndex = fromIndex < insertionIndex ? insertionIndex - 1 : insertionIndex;
        if (toIndex >= 0 && toIndex < itemCount && fromIndex !== toIndex)
          onMove(fromIndex, toIndex);
      }
      finishDrag();
    },
    [findIndexById, finishDrag, itemCount, onMove],
  );

  const startNativeDrag = useCallback(
    (event: DragEvent, id: string, initialIndex: number): void => {
      setDraggedId(id);
      setDropIndex(initialIndex);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    },
    [],
  );

  const handleNativeDragOver = useCallback(
    (event: DragEvent): void => {
      if (draggedId === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropIndex(getDropIndex(axis === "horizontal" ? event.clientX : event.clientY));
    },
    [axis, draggedId, getDropIndex],
  );

  const handleNativeDrop = useCallback(
    (event: DragEvent): void => {
      event.preventDefault();
      const coordinate = axis === "horizontal" ? event.clientX : event.clientY;
      moveById(
        event.dataTransfer.getData("text/plain") || draggedId,
        dropIndex ?? getDropIndex(coordinate),
      );
    },
    [axis, draggedId, dropIndex, getDropIndex, moveById],
  );

  const startPointerDrag = useCallback(
    (event: ReactMouseEvent, id: string): void => {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;
      const onMove = (moveEvent: MouseEvent): void => {
        if (!active && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5)
          return;
        if (!active) {
          active = true;
          setDraggedId(id);
          document.body.style.userSelect = "none";
        }
        moveEvent.preventDefault();
        setDropIndex(getDropIndex(axis === "horizontal" ? moveEvent.clientX : moveEvent.clientY));
      };
      const onUp = (upEvent: MouseEvent): void => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (!active) return;
        upEvent.preventDefault();
        moveById(id, getDropIndex(axis === "horizontal" ? upEvent.clientX : upEvent.clientY));
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [axis, getDropIndex, moveById],
  );

  return {
    draggedId,
    dropIndex,
    setDropIndex,
    getDropIndex,
    finishDrag,
    startNativeDrag,
    handleNativeDragOver,
    handleNativeDrop,
    moveById,
    startPointerDrag,
  };
}
