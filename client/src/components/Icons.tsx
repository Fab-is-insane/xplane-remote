// Inline SVG icons (no external assets, CSP-friendly).

type P = { className?: string };

export function LogoMark({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="27" fill="none" stroke="currentColor" strokeOpacity=".28" strokeWidth="2" />
      <path d="M32 5v6M32 53v6M5 32h6M53 32h6" stroke="currentColor" strokeOpacity=".4" strokeWidth="2" strokeLinecap="round" />
      <path
        fill="currentColor"
        d="M32 13c1.5 0 2.5 1.5 2.5 3.4v10.4l14.2 8.3v3.8l-14.2-4.3v8l4.3 3.2v3l-6.8-1.7-6.8 1.7v-3l4.3-3.2v-8l-14.2 4.3v-3.8l14.2-8.3V16.4c0-1.9 1-3.4 2.5-3.4z"
      />
    </svg>
  );
}

export function PauseIcon({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" />
      <rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" />
    </svg>
  );
}

export function PlayIcon({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 4.8v14.4c0 .8.9 1.3 1.6.8l10.6-7.2c.6-.4.6-1.2 0-1.6L9.6 4c-.7-.5-1.6 0-1.6.8z" fill="currentColor" />
    </svg>
  );
}

export function ChevronIcon({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ExternalIcon({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RefreshIcon({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LogoutIcon({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Spinner({ className }: P) {
  return (
    <svg className={`spinner ${className ?? ''}`} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
