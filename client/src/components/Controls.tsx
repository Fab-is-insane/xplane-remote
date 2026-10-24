import { useState } from 'react';
import { UnauthorizedError, requestPause, type PauseAction, type PublicState } from '../api';
import { fmtClock } from '../format';
import { PauseIcon, PlayIcon, Spinner } from './Icons';

interface Props {
  state: PublicState | null;
  /** True only when the dashboard shows fresh, live data. */
  live: boolean;
  onUnauthorized: () => void;
}

type Feedback = { tone: 'good' | 'info' | 'bad'; text: string } | null;

export function Controls({ state, live, onUnauthorized }: Props) {
  const [pending, setPending] = useState<PauseAction | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const control = state?.control;
  const paused = live ? (state?.telemetry.paused ?? null) : null;
  const serverBusy = control?.inFlight ?? null;
  const busy = pending ?? serverBusy;
  const canAct = Boolean(live && control?.available) && busy === null;

  async function run(action: PauseAction) {
    if (pending) return; // guard against double taps before React re-renders
    setPending(action);
    setFeedback(null);
    navigator.vibrate?.(10);
    try {
      const r = await requestPause(action);
      if (r.ok) {
        const word = r.paused ? 'PAUSED' : 'RUNNING';
        setFeedback(
          r.result === 'already'
            ? { tone: 'info', text: `already ${word} // verified, no command sent` }
            : { tone: 'good', text: `${fmtClock(r.confirmedAt)} ACK sim/time/paused=${r.paused ? 1 : 0} → ${word} (${(r.elapsedMs / 1000).toFixed(1)}s)` },
        );
      } else {
        setFeedback({ tone: 'bad', text: r.message });
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      setFeedback({
        tone: 'bad',
        text: 'host unreachable // result unknown. Check the sim status above before trying again.',
      });
    } finally {
      setPending(null);
    }
  }

  const unavailableReason = !state
    ? 'waiting for host…'
    : !live
      ? 'controls locked // no live telemetry'
      : control && !control.available
        ? (control.reason ?? 'Pause control is unavailable.')
        : null;

  return (
    <section className="card controls" aria-labelledby="controls-title">
      <div className="card-head">
        <h2 id="controls-title" className="card-title">
          Remote_ctl
        </h2>
        {control?.commandMode && (
          <span className="card-meta" title="X-Plane command used for pause/resume">
            cmd: {control.commandMode === 'on_off' ? 'pause_on|off' : 'pause_toggle'}
          </span>
        )}
      </div>

      <div className="control-grid">
        <ControlButton
          action="pause"
          label="PAUSE"
          icon={<PauseIcon className="ctl-icon" />}
          current={paused === true}
          busy={busy === 'pause'}
          disabled={!canAct || paused === true}
          onPress={() => run('pause')}
        />
        <ControlButton
          action="resume"
          label="RESUME"
          icon={<PlayIcon className="ctl-icon" />}
          current={paused === false}
          busy={busy === 'resume'}
          disabled={!canAct || paused === false}
          onPress={() => run('resume')}
        />
      </div>

      <div className="control-feedback" aria-live="polite" role="status">
        {feedback ? (
          <p className={`feedback tone-${feedback.tone}`}>{feedback.text}</p>
        ) : busy ? (
          <p className="feedback tone-info">
            <span className="cursor">{busy === 'pause' ? 'sending pause' : 'sending resume'} // awaiting ack from X-Plane</span>
          </p>
        ) : unavailableReason ? (
          <p className="feedback tone-muted">{unavailableReason}</p>
        ) : (
          <p className="feedback tone-muted">
            {paused ? 'sim on HOLD // resume when ready' : 'sim RUNNING // standing by'}
          </p>
        )}
      </div>
    </section>
  );
}

interface ButtonProps {
  action: PauseAction;
  label: string;
  icon: React.ReactNode;
  current: boolean;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}

function ControlButton({ action, label, icon, current, busy, disabled, onPress }: ButtonProps) {
  const sub = busy ? 'awaiting ack' : current ? 'active' : disabled ? 'locked' : action === 'pause' ? 'freeze sim' : 'release sim';
  return (
    <button
      type="button"
      className={`ctl-btn ctl-${action}${current ? ' is-current' : ''}${busy ? ' is-busy' : ''}`}
      onClick={onPress}
      disabled={disabled || busy}
      aria-busy={busy}
      aria-pressed={current}
    >
      <span className="ctl-icon-wrap">{busy ? <Spinner className="ctl-icon" /> : icon}</span>
      <span className="ctl-text">
        <span className="ctl-label">{label}</span>
        <span className="ctl-sub">{sub}</span>
      </span>
    </button>
  );
}
