import type { PublicState } from '../api';
import { DASH, flightLevel, fmtAge, fmtClock, fmtEta, fmtHeading, fmtInt, fmtLat, fmtLon, fmtNm, fmtSigned } from '../format';

interface Props {
  state: PublicState | null;
  live: boolean;
  /** Telemetry age adjusted to "now" on this device. */
  ageMs: number | null;
}

export function FlightStatus({ state, live, ageMs }: Props) {
  const t = state?.telemetry;
  const tod = state?.tod;
  const stale = !live && Boolean(t?.lastUpdate);

  const vs = t?.verticalSpeedFpm ?? null;
  const vsTrend = vs === null || Math.abs(vs) < 100 ? 'level' : vs > 0 ? 'up' : 'down';
  const aircraft = [t?.aircraftName, t?.aircraftIcao].filter(Boolean).join(' · ');

  return (
    <section className={`card flight${stale ? ' is-stale' : ''}`} aria-labelledby="flight-title">
      <div className="card-head">
        <h2 id="flight-title" className="card-title">
          Telemetry
        </h2>
        {stale ? <span className="chip tone-warn">STALE</span> : !t?.lastUpdate ? <span className="chip tone-bad">NO SIGNAL</span> : null}
      </div>
      {aircraft && (
        <p className="aircraft">
          <span className="aircraft-key">subject:</span> {aircraft}
        </p>
      )}

      <TodPanel tod={tod ?? null} gsKt={t?.groundspeedKt ?? null} />

      <dl className="tiles">
        <Tile label="ALT_IND" value={fmtInt(t?.altitudeFt ?? null)} unit="ft" hint={flightLevel(t?.altitudeFt ?? null) ?? 'indicated'} wide />
        <Tile label="GS" value={fmtInt(t?.groundspeedKt ?? null)} unit="kt" />
        <Tile label="IAS" value={fmtInt(t?.iasKt ?? null)} unit="kt" />
        <Tile
          label="V/S"
          value={fmtSigned(vs)}
          unit="fpm"
          hint={vs === null ? undefined : vsTrend === 'level' ? 'lvl' : vsTrend === 'up' ? 'clb ↑' : 'des ↓'}
        />
        <Tile label="HDG" value={t?.headingMagDeg == null ? DASH : `${fmtHeading(t.headingMagDeg)}°`} unit="mag" />
      </dl>

      <p className="updated" aria-live="off">
        {t?.lastUpdate ? (
          <>
            last packet <strong>{fmtAge(ageMs)}</strong> <span className="dim">[{fmtClock(t.lastUpdate)}]</span>
          </>
        ) : (
          'no packets received from X-Plane yet'
        )}
      </p>

      <details className="details">
        <summary>sys info // position, link, datarefs</summary>
        <dl className="kv">
          <dt>lat</dt>
          <dd>{fmtLat(t?.latitude ?? null)}</dd>
          <dt>lon</dt>
          <dd>{fmtLon(t?.longitude ?? null)}</dd>
          <dt>alt_msl</dt>
          <dd>{t?.trueAltitudeFt == null ? DASH : `${fmtInt(t.trueAltitudeFt)} ft`}</dd>
          <dt>link</dt>
          <dd>{state?.link ?? DASH}</dd>
          <dt>packet age</dt>
          <dd>{ageMs === null ? DASH : `${Math.round(ageMs)} ms`}</dd>
          <dt>pause cmd</dt>
          <dd className="mono-sm">
            {state?.control.commandMode === 'on_off' ? 'sim/operation/pause_on|off' : state?.control.commandMode === 'toggle' ? 'sim/operation/pause_toggle' : DASH}
          </dd>
          <dt>state ref</dt>
          <dd className="mono-sm">sim/time/paused</dd>
          <dt>x-plane</dt>
          <dd>{state?.xplaneVersion ?? DASH}</dd>
          <dt>web_api</dt>
          <dd>{state?.apiVersion ?? DASH}</dd>
          <dt>t/d src</dt>
          <dd className="mono-sm">{tod?.source ?? DASH}</dd>
        </dl>
      </details>
    </section>
  );
}

function Tile({ label, value, unit, hint, wide }: { label: string; value: string; unit: string; hint?: string; wide?: boolean }) {
  return (
    <div className={`tile${wide ? ' tile-wide' : ''}`}>
      <dt className="tile-label">{label}</dt>
      <dd className="tile-value">
        <span className="num">{value}</span>
        {value !== DASH && <span className="unit">{unit}</span>}
        {hint && value !== DASH && <span className="tile-hint">{hint}</span>}
      </dd>
    </div>
  );
}

function TodPanel({ tod, gsKt }: { tod: PublicState['tod'] | null; gsKt: number | null }) {
  if (!tod) {
    return (
      <div className="tod tone-muted">
        <span className="tod-label">T/D</span>
        <span className="tod-value">{DASH}</span>
      </div>
    );
  }
  let value: string;
  let unit: string | null = null;
  let tone = 'muted';
  let note: string | null = tod.detail;
  switch (tod.status) {
    case 'ahead':
      value = fmtNm(tod.distanceNm);
      unit = 'NM';
      tone = (tod.distanceNm ?? 99) <= 10 ? 'warn' : 'accent';
      note = [fmtEta(tod.distanceNm, gsKt) ? `${fmtEta(tod.distanceNm, gsKt)} @ current GS` : null, 'along route // zibo fmc']
        .filter(Boolean)
        .join(' · ');
      break;
    case 'passed':
      value = 'PASSED';
      tone = 'good';
      if (tod.distanceNm) note = `${fmtNm(tod.distanceNm)} NM past T/D`;
      break;
    case 'calculating':
      value = 'CALC…';
      break;
    case 'no_td':
      value = 'NO T/D';
      break;
    default:
      value = DASH;
  }
  return (
    <div className={`tod tone-${tone}`} role="group" aria-label="Distance to top of descent">
      <span className="tod-label">DIST T/D</span>
      <span className="tod-value">
        <span className="num">{value}</span>
        {unit && <span className="unit">{unit}</span>}
      </span>
      {note && <span className="tod-note">{note}</span>}
    </div>
  );
}
