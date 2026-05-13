import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const stroke = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const
};

export function IconFolder(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden {...stroke} {...props}>
      <path d="M4 20h16a2 2 0 002-2V8a2 2 0 00-2-2h-7.9a2 2 0 01-1.69-.9L9.6 3.9A2 2 0 007.11 3H4a2 2 0 00-2 2v13a2 2 0 002 2z" />
    </svg>
  );
}

export function IconSettings(props: IconProps): JSX.Element {
  const { strokeWidth: swProp, ...rest } = props;
  const sw = typeof swProp === "number" ? swProp : typeof swProp === "string" ? Number.parseFloat(swProp) || 1.5 : 1.5;
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      <path
        strokeWidth={sw}
        d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.723 6.723 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.145-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z"
      />
      <path strokeWidth={sw} d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  );
}

export function IconChevronsRight(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden {...stroke} {...props}>
      <path d="M13 17l5-5-5-5M6 17l5-5-5-5" />
    </svg>
  );
}

export function IconChevronsLeft(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden {...stroke} {...props}>
      <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
    </svg>
  );
}

export function IconPlus(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden {...stroke} {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconMoreVertical(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden {...stroke} {...props}>
      <circle cx="12" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconClose(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden {...stroke} {...props}>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function IconColumns(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden {...stroke} {...props}>
      <rect x="3" y="3" width="7" height="18" rx="1" />
      <rect x="14" y="3" width="7" height="18" rx="1" />
    </svg>
  );
}

export function IconRows(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden {...stroke} {...props}>
      <rect x="3" y="3" width="18" height="7" rx="1" />
      <rect x="3" y="14" width="18" height="7" rx="1" />
    </svg>
  );
}

export function IconTerminal(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden {...stroke} {...props}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}
