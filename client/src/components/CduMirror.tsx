import { useId, useState, type ReactNode } from 'react';
import type { CduMirror as CduMirrorData, CduScreen } from '../api';

const SIDE_KEY = 'xpr.cdu.side';
const OPEN_KEY = 'xpr.cdu.open';
const SIDE_NAME: Record<CduScreen['side'], string> = { L: 'CAPT', C: 'CTR', R: 'F/O' };

/** Per aircraft: panel title, dataref shown in the hint, and the name used while waiting. */
const AIRCRAFT = {
  ff777: { title: 'CDU mirror', ref: (s: string) => `1-sim/cdu${s}/display/symbols`, name: 'the 777', fmc: 'FF777' },
  toliss: { title: 'MCDU mirror', ref: (s: string) => `AirbusFBW/MCDU${s === 'R' ? 2 : 1}*`, name: 'the ToLiss', fmc: 'ToLiss' },
} as const;

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — not important */
  }
}

/**
 * Read-only live mirror of the FlightFactor 777 CDUs or ToLiss MCDUs, drawn
 * from the screen text, colour and size datarefs the aircraft publishes. Used
 * instead of WebFMC, whose free version supports neither.
 */
export function CduMirror({ data, profile }: { data: CduMirrorData | null; profile: 'ff777' | 'toliss' }) {
  const acf = AIRCRAFT[profile];
  const screens = data?.screens ?? [];
  const [picked, setPicked] = useState<string | null>(() => load(SIDE_KEY));
  const [open, setOpen] = useState(() => load(OPEN_KEY) !== '0');
  const bodyId = useId();
  const screen = screens.find((s) => s.side === picked) ?? screens[0] ?? null;

  const choose = (side: string) => {
    setPicked(side);
    save(SIDE_KEY, side);
  };
  const toggle = () =>
    setOpen((o) => {
      save(OPEN_KEY, o ? '0' : '1');
      return !o;
    });

  return (
    <section className={`card cdu${open ? ' is-open' : ''}`} aria-labelledby="cdu-title">
      <div className="card-head">
        <button type="button" className="collapse-btn" onClick={toggle} aria-expanded={open} aria-controls={bodyId}>
          <h2 id="cdu-title" className="card-title">
            {acf.title}
          </h2>
          <span className="collapse-state" aria-hidden="true">
            {open ? '[-]' : '[+]'}
          </span>
        </button>
        {screens.length > 1 && open && (
          <div className="cdu-tabs" role="tablist" aria-label="Choose CDU">
            {screens.map((s) => (
              <button
                key={s.side}
                type="button"
                role="tab"
                aria-selected={screen?.side === s.side}
                className={`cdu-tab${screen?.side === s.side ? ' is-active' : ''}`}
                onClick={() => choose(s.side)}
              >
                {SIDE_NAME[s.side]}
                {(s.badge ?? (s.isProgress ? 'PROG' : null)) && <span className="cdu-prog">{s.badge ?? 'PROG'}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div id={bodyId} hidden={!open}>
        {screen ? (
          <div className="cdu-screen" role="img" aria-label={`${SIDE_NAME[screen.side]} CDU: ${screen.lines.map((l) => l.trim()).filter(Boolean).join(' / ')}`}>
            {screen.lines.map((line, i) => (
              <div key={i} className="cdu-line">
                {renderLine(line, screen.colors?.[i] ?? null, screen.sizes?.[i] ?? null)}
              </div>
            ))}
          </div>
        ) : (
          <p className="feedback tone-muted">
            <span className="cursor">waiting for CDU data from {acf.name}</span>
          </p>
        )}
        <p className="hint">
          read-only // {acf.ref(screen?.side ?? 'L')} // WebFMC does not support the {acf.fmc}
        </p>
      </div>
    </section>
  );
}

/** Group consecutive characters with the same colour and size into spans. */
function renderLine(line: string, colors: string | null, sizes: string | null): ReactNode[] {
  const out: ReactNode[] = [];
  let start = 0;
  const key = (i: number) => `${colors?.[i] ?? '1'}${sizes?.[i] ?? '1'}`;
  for (let i = 1; i <= line.length; i++) {
    if (i === line.length || key(i) !== key(start)) {
      const c = colors?.[start] ?? '1';
      const z = sizes?.[start] ?? '1';
      out.push(
        <span key={start} className={`cdu-c${c}${z === '2' ? ' cdu-small' : ''}`}>
          {line.slice(start, i)}
        </span>,
      );
      start = i;
    }
  }
  return out;
}
