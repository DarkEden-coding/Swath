import { IconClose, IconColumns, IconRows } from "../../shell/icons";

interface PaneToolbarProps {
  title: string;
  statusClass: string;
  onSplitRight: (shiftKey?: boolean) => void;
  onSplitDown: (shiftKey?: boolean) => void;
  onClose: () => void;
}

export function PaneToolbar({ title, statusClass, onSplitRight, onSplitDown, onClose }: PaneToolbarProps): JSX.Element {
  return (
    <div className="pane-toolbar">
      <div className="pane-title">
        <span className={`status-dot ${statusClass}`} />
        <span className="pane-prompt mono">{title}</span>
      </div>
      <div className="pane-actions">
        <button type="button" className="pane-icon-btn" title="Split right" onClick={(event) => onSplitRight(event.shiftKey)}>
          <IconColumns width={15} height={15} />
        </button>
        <button type="button" className="pane-icon-btn" title="Split down" onClick={(event) => onSplitDown(event.shiftKey)}>
          <IconRows width={15} height={15} />
        </button>
        <button type="button" className="pane-icon-btn" title="Close pane" onClick={onClose}>
          <IconClose width={15} height={15} />
        </button>
      </div>
    </div>
  );
}
