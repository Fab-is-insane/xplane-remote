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
          Flight status
        </h2>
        {stale ? <span className="chip tone-warn">STALE</span> : !t?.lastUpdate ? <span className="chip tone-muted">NO DATA</span> : null}
      </div>
      {aircraft && <p className="aircraft">{aircraft}</p>}

      <TodPanel tod={tod ?? null} gsKt={t?.groundspeedKt ?? null} />

      <dl className="tiles">
        <Tile label="Altitude" value={fmtInt(t?.altitudeFt ?? null)} unit="ft" hint={flightLevel(t?.altitudeFt ?? null) ?? 'indicated'} wide />
        <Tile label="Ground speed" value={fmtInt(t?.groundspeedKt ?? null)} unit="kt" />
        <Tile label="IAS" value={fmtInt(t?.iasKt ?? null)} unit="kt" />
        <Tile
          label="Vertical speed"
          value={fmtSigned(vs)}
          unit="fpm"
          hint={vs === null ? undefined : vsTrend === 'level' ? 'level' : vsTrend === 'up' ? 'climbing' : 'descending'}
        />
        <Tile label="Heading" value={t?.headingMagDeg == null ? DASH : `${fmtHeading(t.headingMagDeg)}°`} unit="mag" />
      </dl>

      <p className="updated" aria-live="off">
        {t?.lastUpdate ? (
          <>
            Updated <strong>{fmtAge(ageMs)}</strong> <span className="dim">({fmtClock(t.lastUpdate)})</span>
          </>
        ) : (
          'No telemetry received from X-Plane yet.'
        )}
      </p>

      <details className="details">
        <summary>Position &amp; details</summary>
        <dl className="kv">
          <dt>Latitude</dt>
          <dd>{fmtLat(t?.latitude ?? null)}</dd>
          <dt>Longitude</dt>
          <dd>{fmtLon(t?.longitude ?? null)}</dd>
          <dt>True altitude (MSL)</dt>
          <dd>{t?.trueAltitudeFt == null ? DASH : `${fmtInt(t.trueAltitudeFt)} ft`}</dd>
          <dt>X-Plane</dt>
          <dd>{state?.xplaneVersion ?? DASH}</dd>
          <dt>Web API</dt>
          <dd>{state?.apiVersion ?? DASH}</dd>
          <dt>T/D source</dt>
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
        <span className="tod-label">Top of descent</span>
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
      note = [fmtEta(tod.distanceNm, gsKt) ? `${fmtEta(tod.distanceNm, gsKt)} at current GS` : null, 'along route (Zibo FMC)']
        .filter(Boolean)
        .join(' · ');
      break;
    case 'passed':
      value = 'Passed';
      tone = 'good';
      if (tod.distanceNm) note = `${fmtNm(tod.distanceNm)} NM past T/D`;
      break;
    case 'calculating':
      value = 'Calculating';
      break;
    case 'no_td':
      value = 'No T/D';
      break;
    default:
      value = DASH;
  }
  return (
    <div className={`tod tone-${tone}`} role="group" aria-label="Distance to top of descent">
      <span className="tod-label">To T/D</span>
      <span className="tod-value">
        <span className="num">{value}</span>
        {unit && <span className="unit">{unit}</span>}
      </span>
      {note && <span className="tod-note">{note}</span>}
    </div>
  );
}
