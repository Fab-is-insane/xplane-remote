import { useId, useState, type ReactNode } from 'react';
import type { CduMirror as CduMirrorData, CduScreen } from '../api';

const SIDE_KEY = 'xpr.cdu.side';
const OPEN_KEY = 'xpr.cdu.open';
const SIDE_NAME: Record<CduScreen['side'], string> = { L: 'CAPT', C: 'CTR', R: 'F/O' };

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
 * Read-only live mirror of the FlightFactor 777 CDUs, drawn from the screen
 * text, colour and size datarefs the aircraft publishes. Used instead of
 * WebFMC, which does not support the FF777.
 */
export function CduMirror({ data }: { data: CduMirrorData | null }) {
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
            CDU mirror
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
                {s.isProgress && <span className="cdu-prog">PROG</span>}
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
            <span className="cursor">waiting for CDU data from the 777</span>
          </p>
        )}
        <p className="hint">read-only // 1-sim/cdu{screen?.side ?? 'L'}/display/symbols // WebFMC does not support the FF777</p>
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
