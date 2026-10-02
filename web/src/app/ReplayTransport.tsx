import { Pause, Play } from "lucide-react";
import { useId, type CSSProperties } from "react";
import { motion } from "motion/react";

import { cn } from "../lib/cn";
import { formatClock } from "../lib/format";
import { Button } from "../components/ui/Button";
import { SPEEDS, type Divergence, type Speed, type TransportState } from "../run/RunSource";
import { useRunSource } from "../run/RunSourceContext";

interface ViewProps {
  transport: TransportState;
  onPlay: () => void;
  onPause: () => void;
  onSpeed: (speed: Speed) => void;
  onSeek: (fraction: number) => void;
  /** Disabled while the run is paused at a gate: a gate is answered, not scrubbed past. */
  locked?: boolean;
}

const SCRUB_STEPS = 1000;

/** Filled, not outlined: a transport glyph reads as a solid control, and lucide's stroke-only
 * default would look hollow next to the filled Sun/Moon-sized buttons around it. */
function PlayIcon() {
  return <Play aria-hidden="true" className="size-4 shrink-0" fill="currentColor" strokeWidth={2} />;
}

function PauseIcon() {
  return <Pause aria-hidden="true" className="size-4 shrink-0" fill="currentColor" strokeWidth={2} />;
}

/** The replay controls of docs/design-plan.md §5: play/pause, 1× 4× 16×, and a scrubber. Speed is
 * a native radio group, so arrow keys, focus and screen-reader semantics come for free; the radio
 * inputs are visually hidden and their focus ring is drawn on the pill beside them. */
export function ReplayTransportView({ transport, onPlay, onPause, onSpeed, onSeek, locked }: ViewProps) {
  const { playing, speed, elapsedS, durationS } = transport;
  const fraction = durationS > 0 ? elapsedS / durationS : 0;
  // §7 M9g: the selected pill slides via the same shared-layoutId technique as the tab indicator.
  const pillId = useId();

  return (
    <div className="flex items-center gap-2 frame:gap-3">
      <Button
        variant="quiet"
        className="w-8 px-0"
        aria-label={playing ? "Pause replay" : "Play replay"}
        onClick={playing ? onPause : onPlay}
        disabled={locked === true}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>

      <fieldset className="flex items-center gap-1 border-0 p-0">
        <legend className="sr-only">Playback speed</legend>
        {SPEEDS.map((option) => (
          <label key={option} className="relative">
            <input
              type="radio"
              name="replay-speed"
              className="peer sr-only"
              checked={speed === option}
              onChange={() => onSpeed(option)}
            />
            {speed === option && (
              <motion.span
                aria-hidden="true"
                layoutId={pillId}
                className="absolute inset-0 rounded-pill bg-accent-soft shadow-highlight ring-1 ring-inset ring-accent-hover/60"
                transition={{ duration: 0.24, ease: [0.65, 0, 0.35, 1] }}
              />
            )}
            <span
              className={cn(
                "num relative inline-flex h-7 min-w-9 cursor-pointer items-center justify-center rounded-pill px-2 text-xs transition-colors duration-(--dur-quick) ease-out",
                "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-line-focus",
                speed === option ? "text-fg" : "text-fg-secondary hover:bg-surface-raised",
              )}
            >
              {option}×
            </span>
          </label>
        ))}
      </fieldset>

      <input
        type="range"
        min={0}
        max={SCRUB_STEPS}
        step={1}
        value={Math.round(fraction * SCRUB_STEPS)}
        onChange={(event) => onSeek(Number(event.target.value) / SCRUB_STEPS)}
        disabled={locked === true}
        aria-label="Replay position"
        aria-valuetext={`${formatClock(elapsedS)} of ${formatClock(durationS)}`}
        // `range-brand` (styles/base.css) draws the filled track from --fill, a percentage the
        // component owns; the thumb and track are tokenized there, replacing the browser default.
        style={{ "--fill": `${(fraction * 100).toFixed(1)}%` } as CSSProperties}
        className="range-brand hidden w-40 frame:block"
      />
      <span className="num hidden whitespace-nowrap text-xs text-fg-muted sm:inline">
        {formatClock(elapsedS)} / {formatClock(durationS)}
      </span>
    </div>
  );
}

/** The one honest line the replay owes an operator who answers a gate differently from the
 * recording: it carries on down the only future that was recorded, and says so. */
export function DivergenceNotice({ divergence }: { divergence: Divergence | null }) {
  if (divergence === null) return null;
  const said = divergence.operatorApproved ? "approved" : "rejected";
  const recorded = divergence.recordedApproved ? "approved" : "rejected";
  return (
    <p role="status" className="border-l-2 border-status-warn pl-3 text-sm text-fg-secondary">
      You {said} the {divergence.gate} gate; the recording {recorded} it. Playback follows the
      recording, since that is the only future that was captured.
    </p>
  );
}

/** Wired to the run source in context. Renders nothing for a live run, which has no transport. */
export function ReplayTransport() {
  const { source, state } = useRunSource();
  if (state.transport === null) return null;
  return (
    <ReplayTransportView
      transport={state.transport}
      onPlay={source.play}
      onPause={source.pause}
      onSpeed={source.setSpeed}
      onSeek={source.seek}
      locked={state.awaitingDecision}
    />
  );
}
