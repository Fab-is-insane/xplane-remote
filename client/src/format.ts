// Display formatting. Every function returns "—" for missing data so the UI
// never shows a placeholder number as if it were real.

export const DASH = '—';

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function fmtInt(v: number | null): string {
  return v === null ? DASH : intFmt.format(Math.round(v));
}

export function fmtSigned(v: number | null): string {
  if (v === null) return DASH;
  const r = Math.round(v);
  if (r === 0) return '0';
  return `${r > 0 ? '+' : '−'}${intFmt.format(Math.abs(r))}`;
}

export function fmtHeading(v: number | null): string {
  if (v === null) return DASH;
  const h = Math.round(v) % 360;
  return String(h === 0 ? 360 : h).padStart(3, '0');
}

export function fmtNm(v: number | null): string {
  if (v === null) return DASH;
  return v < 100 ? oneDecimal.format(v) : intFmt.format(Math.round(v));
}

export function flightLevel(altFt: number | null): string | null {
  if (altFt === null || altFt < 10000) return null;
  return `FL${String(Math.round(altFt / 100)).padStart(3, '0')}`;
}

export function fmtLat(v: number | null): string {
  if (v === null) return DASH;
  return `${Math.abs(v).toFixed(4)}° ${v >= 0 ? 'N' : 'S'}`;
}

export function fmtLon(v: number | null): string {
  if (v === null) return DASH;
  return `${Math.abs(v).toFixed(4)}° ${v >= 0 ? 'E' : 'W'}`;
}

export function fmtAge(ms: number | null): string {
  if (ms === null) return 'never';
  if (ms < 1500) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

export function fmtClock(epochMs: number | null): string {
  if (epochMs === null) return DASH;
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** "23 min", "1 h 05 min". */
export function fmtDuration(min: number | null): string {
  if (min === null) return DASH;
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Wall-clock time on this phone, e.g. "19:53". */
export function fmtLocalTime(epochMs: number | null): string {
  if (epochMs === null) return DASH;
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Rough time to go at the current ground speed, clearly an estimate. */
export function fmtEta(distanceNm: number | null, gsKt: number | null): string | null {
  if (distanceNm === null || gsKt === null || gsKt < 60) return null;
  const min = (distanceNm / gsKt) * 60;
  if (min < 1) return '< 1 min';
  if (min < 120) return `≈ ${Math.round(min)} min`;
  return `≈ ${Math.floor(min / 60)} h ${Math.round(min % 60)} min`;
}
