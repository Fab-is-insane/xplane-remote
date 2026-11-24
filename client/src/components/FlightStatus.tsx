import type { PublicState } from '../api';
import {
  DASH,
  flightLevel,
  fmtAge,
  fmtClock,
  fmtDuration,
  fmtEta,
  fmtHeading,
  fmtInt,
  fmtLat,
  fmtLon,
  fmtLocalTime,
  fmtNm,
  fmtSigned,
} from '../format';

interface Props {
  state: PublicState | null;
  live: boolean;
  /** Telemetry age adjusted to "now" on this device. */
  ageMs: number | null;
}

export function FlightStatus({ state, live, ageMs }: Props) {
  const t = state?.telemetry;
  const tod = state?.tod;
  const dest = state?.dest;
  // After T/D the question changes from "when do I descend" to "when do I land".
  const showArrival = tod?.status === 'passed' && Boolean(dest?.available);
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

      {showArrival && dest ? (
        <ArrivalPanel dest={dest} />
      ) : (
        <>
          <TodPanel tod={tod ?? null} gsKt={t?.groundspeedKt ?? null} />
          {dest?.available && <DestLine dest={dest} />}
        </>
      )}

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
          <dt>fmc profile</dt>
          <dd className="mono-sm">
            {state?.profile === 'zibo737'
              ? 'zibo 737 (laminar/B738 datarefs)'
              : state?.profile === 'ff777'
                ? 'ff 777v2 (1-sim cdu screens)'
                : state?.profile === 'toliss'
                  ? 'toliss a321 (AirbusFBW fms + mcdu)'
                  : (state?.profile ?? DASH)}
          </dd>
          <dt>t/d src</dt>
          <dd className="mono-sm">{tod?.source ?? DASH}</dd>
          <dt>t/d model</dt>
          <dd className="mono-sm">
            {tod?.estimated
              ? state?.profile === 'toliss'
                ? 'DistToDest − (CRZ FL/1000 × 3 + 10) · est.'
                : 'DEST DTG − (3 NM/1000 ft + 10) · est.'
              : tod?.source === 'AirbusFBW/APPhase'
                ? 'fmgs flight phase'
                : tod?.source
                  ? 'fmc value'
                  : DASH}
          </dd>
          <dt>dest src</dt>
          <dd className="mono-sm">{dest?.source ?? DASH}</dd>
          <dt>eta model</dt>
          <dd className="mono-sm">dist_dest ÷ GS (live) · FMC time_dest − sim zulu</dd>
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
      value = `${tod.estimated ? '~' : ''}${fmtNm(tod.distanceNm)}`;
      unit = 'NM';
      tone = (tod.distanceNm ?? 99) <= 10 ? 'warn' : 'accent';
      note = [
        // The FMS's own T/D time beats distance ÷ ground speed when the aircraft shows one.
        tod.fmcEtaZulu
          ? `FMS T/D ${tod.fmcEtaZulu}Z${tod.fmcEtaMinutes != null ? ` (in ${fmtDuration(tod.fmcEtaMinutes)})` : ''}`
          : fmtEta(tod.distanceNm, gsKt)
            ? `${fmtEta(tod.distanceNm, gsKt)} @ current GS`
            : null,
        tod.detail,
      ]
        .filter(Boolean)
        .join(' · ');
      break;
    case 'passed':
      value = 'PASSED';
      tone = 'good';
      if (tod.distanceNm) note = `${fmtNm(tod.distanceNm)} NM past T/D`;
      break;
    case 'climb':
      value = 'CLIMB';
      tone = 'accent';
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
      <span className="tod-label">DIST T/D{tod.estimated && tod.status === 'ahead' ? ' (EST)' : ''}</span>
      <span className="tod-value">
        <span className="num">{value}</span>
        {unit && <span className="unit">{unit}</span>}
      </span>
      {note && <span className="tod-note">{note}</span>}
    </div>
  );
}

/** After T/D: big "time to go" from live telemetry, with the FMC's own ETA beside it. */
function ArrivalPanel({ dest }: { dest: PublicState['dest'] }) {
  const live = dest.liveEtaMinutes;
  const fmc = dest.fmcEtaMinutes;
  const value = live !== null ? fmtDuration(live) : fmc !== null ? fmtDuration(fmc) : `${fmtNm(dest.distanceNm)} NM`;
  const notes = [
    live !== null ? `≈ ${fmtLocalTime(dest.liveEtaAt)} local · ${fmtNm(dest.distanceNm)} NM to go @ current GS` : dest.detail,
    dest.fmcEtaZulu ? `FMC ETA ${dest.fmcEtaZulu}Z${fmc !== null ? ` (in ${fmtDuration(fmc)})` : ''}` : null,
  ].filter(Boolean);
  return (
    <div className="tod tone-good" role="group" aria-label="Estimated time to destination">
      <span className="tod-label">ETA {dest.icao ?? 'DEST'} · T/D PASSED</span>
      <span className="tod-value">
        <span className="num">{value}</span>
      </span>
      {notes.map((n) => (
        <span key={n} className="tod-note">
          {n}
        </span>
      ))}
    </div>
  );
}

/** Before T/D: one compact line about the destination. */
function DestLine({ dest }: { dest: PublicState['dest'] }) {
  return (
    <p className="dest-line">
      <span className="dim">dest</span> {dest.icao ?? '----'} · {fmtNm(dest.distanceNm)} NM
      {dest.fmcEtaZulu && <> · FMC ETA {dest.fmcEtaZulu}Z</>}
      {dest.liveEtaMinutes !== null && <> · ≈ {fmtDuration(dest.liveEtaMinutes)}</>}
    </p>
  );
}
