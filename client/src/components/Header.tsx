import type { LinkStatus } from '../status';
import { LogoMark, LogoutIcon } from './Icons';

interface Props {
  link: LinkStatus;
  /** Confirmed sim state, or null when it cannot be trusted right now. */
  paused: boolean | null;
  onSignOut: () => void;
}

export function Header({ link, paused, onSignOut }: Props) {
  const simLabel = paused === null ? 'UNKNOWN' : paused ? 'PAUSED' : 'RUNNING';
  const simTone = paused === null ? 'muted' : paused ? 'warn' : 'good';
  return (
    <header className="topbar">
      <div className="brand">
        <LogoMark className="brand-mark" />
        <div className="brand-text">
          <span className="brand-name">X-Plane Remote</span>
          <span className="brand-sub">Flight companion</span>
        </div>
      </div>
      <div className="topbar-status">
        <span className={`pill tone-${link.tone}`} title={link.detail} role="status" aria-label={`Connection: ${link.label}. ${link.detail}`}>
          <span className="pill-dot" aria-hidden="true" />
          {link.label}
        </span>
        <span className={`sim-badge tone-${simTone}`} aria-label={`Simulator ${simLabel.toLowerCase()}`}>
          {simLabel}
        </span>
        <button type="button" className="icon-btn" onClick={onSignOut} aria-label="Sign out" title="Sign out">
          <LogoutIcon className="icon" />
        </button>
      </div>
    </header>
  );
}
