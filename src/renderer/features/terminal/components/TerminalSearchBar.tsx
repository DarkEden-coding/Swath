interface TerminalSearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}

export function TerminalSearchBar({ query, onQueryChange, onPrevious, onNext, onClose }: TerminalSearchBarProps): JSX.Element {
  return (
    <div className="terminal-search">
      <input autoFocus value={query} placeholder="Find" onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter") onNext();
        if (event.key === "Escape") onClose();
      }} />
      <button type="button" onClick={onPrevious}>↑</button>
      <button type="button" onClick={onNext}>↓</button>
      <button type="button" onClick={onClose}>×</button>
    </div>
  );
}
