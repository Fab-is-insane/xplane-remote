import type { LinkStatus } from '../status';

interface Props {
  link: LinkStatus;
  /** Confirmed sim state, or null when it cannot be trusted right now. */
  paused: boolean | null;
  onSignOut: () => void;
}

export function Header({ link, paused, onSignOut }: Props) {
  const simLabel = paused === null ? '????' : paused ? 'HOLD' : 'RUN';
  const simWord = paused === null ? 'unknown' : paused ? 'paused' : 'running';
  const simTone = paused === null ? 'muted' : paused ? 'warn' : 'good';
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          XPR
        </span>
        <span className="brand-name">x-plane remote</span>
      </div>
      <div className="topbar-status">
        <span className={`pill tone-${link.tone}`} title={link.detail} role="status" aria-label={`Connection: ${link.label}. ${link.detail}`}>
          <span className="pill-dot" aria-hidden="true" />
          {link.label}
        </span>
        <span className={`sim-badge tone-${simTone}`} aria-label={`Simulator ${simWord}`} title={`Simulator ${simWord}`}>
          {simLabel}
        </span>
        <button type="button" className="icon-btn" onClick={onSignOut} aria-label="Sign out" title="Sign out">
          exit
        </button>
      </div>
    </header>
  );
}
