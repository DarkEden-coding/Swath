interface TerminalSearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}

const searchBtn =
  "grid size-[26px] cursor-pointer place-items-center rounded-md border border-transparent bg-transparent text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border hover:bg-[rgba(56,139,253,0.12)]";

export function TerminalSearchBar({
  query,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
}: TerminalSearchBarProps): JSX.Element {
  return (
    <div className="absolute right-3.5 top-[42px] z-30 flex items-center gap-1 rounded-lg border border-swath-border bg-[rgba(13,17,23,0.96)] p-1.5 shadow-swath [-webkit-app-region:no-drag] [app-region:no-drag]">
      <input
        className="w-[180px] rounded-md border border-swath-border bg-[#010409] px-2 py-1 text-sm text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag]"
        autoFocus
        value={query}
        placeholder="Find"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onNext();
          if (event.key === "Escape") onClose();
        }}
      />
      <button type="button" className={searchBtn} onClick={onPrevious}>
        ↑
      </button>
      <button type="button" className={searchBtn} onClick={onNext}>
        ↓
      </button>
      <button type="button" className={searchBtn} onClick={onClose}>
        ×
      </button>
    </div>
  );
}
