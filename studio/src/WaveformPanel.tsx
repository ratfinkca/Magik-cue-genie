import { MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { visibleBeats } from "./beatGrid";
import { formatTime } from "./cues";
import type { Cue } from "./cues";
import { getLoop } from "./loops";
import { centeredTimeRange, drawWaveform, timelineStep } from "./waveform";
import type { WaveformData, WaveformMode } from "./waveform";
import "./waveform.css";

function WaveCanvas({ data, start, end, mode }: {
  data: WaveformData | null; start: number; end: number; mode: WaveformMode;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef({ data, start, end, mode });
  drawing.current = { data, start, end, mode };
  const paint = () => {
    const canvas = ref.current;
    if (!canvas) return;
    const latest = drawing.current;
    if (latest.data) drawWaveform(canvas, latest.data, latest.start, latest.end, latest.mode);
    else canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  };
  useLayoutEffect(paint, [data, start, end, mode]);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(paint);
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return <canvas ref={ref} aria-hidden="true" />;
}

const demoPhrases = [
  { name: "Intro", start: 0, end: 8 },
  { name: "Build", start: 8, end: 16 },
  { name: "Drop", start: 16, end: 24 },
  { name: "Outro", start: 24, end: 32 },
];

const clamp = (time: number, duration: number) => Math.max(0, Math.min(duration, time));
const isLeadIn = (cue: Cue) => Boolean(cue.metadata?.lead_in && typeof cue.metadata.lead_in === "object");

function cueLoop(cue: Cue, duration: number) {
  const value = getLoop(cue, duration);
  return value && { start: cue.time_seconds, end: value.end_seconds, active: value.active };
}

function timeAtPointer(clientX: number, element: HTMLElement, start: number, span: number) {
  const rect = element.getBoundingClientRect();
  return start + (clientX - rect.left) / Math.max(1, rect.width) * span;
}

function tickLabel(time: number, step: number) {
  if (step >= 1) return formatTime(time);
  const digits = Math.min(3, Math.max(1, Math.ceil(-Math.log10(step))));
  return formatTime(time, true).slice(0, -(3 - digits) || undefined);
}

type CueDrag = {
  index: number;
  originX: number;
  clientX: number;
  grabOffset: number;
  moved: boolean;
};

type PanelProps = {
  data: WaveformData | null;
  duration: number;
  position: number;
  cues: Cue[];
  selected: number | null;
  demo: boolean;
  select: (index: number) => void;
  seek: (time: number) => void;
  moveCue: (index: number, time: number) => void;
  pending: boolean;
  isPlaying?: boolean;
  getPosition?: () => number;
  leadInPreview?: number | null;
  beatTimes?: number[];
};

export default function WaveformPanel({ data, duration, position, cues, selected, demo,
  select, seek, moveCue, pending, isPlaying = false, getPosition, leadInPreview = null, beatTimes = [] }: PanelProps) {
  const [mode, setMode] = useState<WaveformMode>("rgb");
  const [showGrid, setShowGrid] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [framePosition, setFramePosition] = useState(position);
  const [plotWidth, setPlotWidth] = useState(700);
  const [drag, setDrag] = useState<CueDrag | null>(null);
  const dragRef = useRef<CueDrag | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const maxZoom = Math.pow(2, Math.floor(Math.log2(Math.max(1, Math.min(128, duration / 0.5)))));
  const effectiveZoom = Math.min(zoom, maxZoom);
  const currentPosition = clamp(isPlaying && getPosition ? framePosition : position, duration);
  const { start, end, span } = centeredTimeRange(duration, currentPosition, effectiveZoom);
  const percent = (time: number) => `${span > 0 ? 100 * (time - start) / span : 50}%`;
  const viewRef = useRef({ start, span });
  viewRef.current = { start, span };
  const step = timelineStep(span, plotWidth);
  const ticks = duration > 0
    ? Array.from({ length: Math.ceil(span / step) + 1 }, (_, index) => (Math.ceil(start / step) + index) * step)
      .filter((value) => value >= 0 && value <= duration && value <= end)
    : [];
  const beats = showGrid ? visibleBeats(beatTimes, start, end, plotWidth) : [];

  useLayoutEffect(() => { setFramePosition(isPlaying && getPosition ? getPosition() : position); }, [position, isPlaying, getPosition]);
  useEffect(() => {
    if (!isPlaying || !getPosition) return;
    let frame = 0;
    const tick = () => {
      setFramePosition(getPosition());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, getPosition]);
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const observer = new ResizeObserver(() => setPlotWidth(plot.getBoundingClientRect().width));
    setPlotWidth(plot.getBoundingClientRect().width);
    observer.observe(plot);
    return () => observer.disconnect();
  }, []);

  const seekTo = (time: number) => {
    const next = clamp(time, duration);
    setFramePosition(next);
    seek(next);
  };
  const cueDragTime = (active: CueDrag, exactClock = false) => {
    if (!active.moved || !plotRef.current) return cues[active.index]?.time_seconds ?? 0;
    // Keep the grabbed offset under the pointer while audio moves behind it.
    // Reading the audio clock here also covers pointer events between frames.
    const current = exactClock && getPosition ? clamp(getPosition(), duration) : currentPosition;
    const range = centeredTimeRange(duration, current, effectiveZoom);
    return clamp(timeAtPointer(active.clientX, plotRef.current, range.start, range.span) - active.grabOffset, duration);
  };
  const updateDrag = (next: CueDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  };
  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
    event.stopPropagation();
    if (event.button !== 0 || !plotRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const range = viewRef.current;
    updateDrag({ index, originX: event.clientX, clientX: event.clientX, moved: false,
      grabOffset: timeAtPointer(event.clientX, plotRef.current, range.start, range.span) - cues[index].time_seconds });
    select(index);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = dragRef.current;
    if (!active || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    updateDrag({ ...active, clientX: event.clientX,
      moved: active.moved || Math.abs(event.clientX - active.originX) >= 3 });
  };
  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = dragRef.current;
    if (active?.moved) moveCue(active.index, cueDragTime({ ...active, clientX: event.clientX }, true));
    updateDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const preview = leadInPreview !== null && Number.isFinite(leadInPreview)
    && leadInPreview >= 0 && leadInPreview <= duration
    && !cues.some((cue) => isLeadIn(cue) && Math.abs(cue.time_seconds - leadInPreview) < 0.005)
    ? leadInPreview : null;
  const visibleStart = Math.max(0, start);
  const visibleEnd = Math.min(duration, end);
  const dragTime = drag ? cueDragTime(drag) : null;
  const loops = cues.map((cue, index) => ({ index, loop: cueLoop(cue, duration) }))
    .filter((item): item is { index: number; loop: NonNullable<ReturnType<typeof cueLoop>> } => item.loop !== null);

  return <section className="panel wave-panel" aria-label="Track waveform">
    <div className="panel-toolbar">
      <h2>Waveform</h2>
      <div className="wave-tools">
        <div className="band-legend" aria-label="Frequency colors">
          <span><i className="low" /> Low</span><span><i className="mid" /> Mid</span><span><i className="high" /> High</span>
        </div>
        <div className="segments wave-mode" aria-label="Waveform view">
          <button aria-pressed={mode === "rgb"} onClick={() => setMode("rgb")} title="One color per slice, blended from its frequency balance">RGB</button>
          <button aria-pressed={mode === "bands"} onClick={() => setMode("bands")} title="Overlaid low, mid, and high frequency bands">Tri-band</button>
          <button aria-pressed={mode === "split"} onClick={() => setMode("split")} title="Separate low, mid, and high frequency lanes">Split</button>
        </div>
        {!!beatTimes.length && <div className="segments">
          <button aria-pressed={showGrid} title="Toggle observed beat markers" onClick={() => setShowGrid(!showGrid)}>Beatgrid</button>
        </div>}
        <div className="segments zoom-controls" aria-label="Waveform zoom">
          <button aria-label="Zoom out" disabled={!duration || effectiveZoom <= 1 || Boolean(drag)} onClick={() => setZoom(Math.max(1, effectiveZoom / 2))}><MinusIcon /></button>
          <span>{effectiveZoom}×</span>
          <button aria-label="Zoom in" disabled={!duration || effectiveZoom >= maxZoom || Boolean(drag)} onClick={() => setZoom(Math.min(maxZoom, effectiveZoom * 2))}><PlusIcon /></button>
        </div>
      </div>
    </div>
    <div className="ruler" aria-hidden="true">
      {ticks.map((tick) => <span key={tick}
        className={tick - start < span * 0.025 ? "tick-start" : end - tick < span * 0.025 ? "tick-end" : ""}
        style={{ left: percent(tick) }}>{tickLabel(tick, step)}</span>)}
      {duration > 0 && <i className="ruler-head" />}
    </div>
    <div className="wave-plot" ref={plotRef} data-mode={mode}
      onPointerDown={(event) => {
        if (event.button !== 0 || !duration) return;
        const view = viewRef.current;
        seekTo(timeAtPointer(event.clientX, event.currentTarget, view.start, view.span));
      }}>
      <WaveCanvas data={data} start={start} end={end} mode={mode} />
      {beats.map((time) => <span className="observed-beat" key={time} aria-hidden="true" style={{ left: percent(time) }} />)}
      {loops.filter(({ loop }) => loop.end > start && loop.start < end).map(({ index, loop }) => (
        <div key={index} className={`wave-loop ${loop.active ? "active" : ""}`} aria-hidden="true"
          style={{ left: percent(Math.max(start, loop.start)), width: `${100 * (Math.min(end, loop.end) - Math.max(start, loop.start)) / span}%` }}>
          <span>{loop.active ? "Loop" : "Saved loop"}</span>
        </div>
      ))}
      {!data && <p className="plot-message">{pending ? "Reading frequency bands…" : "Open an audio file to see its waveform."}</p>}
      {duration > 0 && <div className="playhead centered-playhead" aria-hidden="true" />}
      {duration > 0 && cues.map((cue, index) => {
        const active = drag?.index === index;
        const time = active && dragTime !== null ? dragTime : cue.time_seconds;
        if (!active && (time < start || time > end)) return null;
        const ratio = (time - start) / span;
        const leadIn = isLeadIn(cue);
        return <div key={index} className={`cue-marker ${selected === index ? "selected" : ""} ${leadIn ? "lead-in-cue" : ""} ${getLoop(cue, duration) ? "loop-cue" : ""}`}
          style={{ left: percent(time) }}>
          <button className={`marker-flag ${ratio > 0.75 ? "align-left" : ""}`} type="button"
            aria-label={`Select ${leadIn ? "lead-in " : ""}cue ${index + 1}: ${cue.label}`} aria-pressed={selected === index}
            title={`${cue.label} · ${formatTime(time, true)}\nDrag to move cue`}
            onClick={() => select(index)} onPointerDown={(event) => beginDrag(event, index)}
            onPointerMove={moveDrag} onPointerUp={finishDrag}
            onLostPointerCapture={() => updateDrag(null)} onPointerCancel={() => updateDrag(null)}>
            <span>{leadIn ? "↳ " : ""}{index + 1}</span>{cue.label}
          </button>
        </div>;
      })}
      {preview !== null && preview >= start && preview <= end && <div className="lead-in-preview" style={{ left: percent(preview) }} aria-hidden="true"><span>Lead-in</span></div>}
    </div>
    {demo && <div className="phrase-strip" aria-label="Demo arrangement">
      {demoPhrases.filter((phrase) => phrase.end > start && phrase.start < end).map((phrase) => (
        <span key={phrase.name} className={`phrase ${phrase.name.toLowerCase()}`}
          style={{ left: percent(Math.max(start, phrase.start)), width: `${100 * (Math.min(end, phrase.end) - Math.max(start, phrase.start)) / span}%` }}>
          {phrase.name}
        </span>
      ))}
      {duration > 0 && <i className="phrase-head" aria-hidden="true" />}
    </div>}
    <div className="overview-label"><span>Full track <span className="overview-hint">· select a cue to jump</span></span><span className="time">{formatTime(duration)}</span></div>
    <div className="overview" role="group" aria-label="Full track overview" onPointerDown={(event) => {
      if (event.button !== 0 || !duration) return;
      seekTo(timeAtPointer(event.clientX, event.currentTarget, 0, duration));
    }}>
      <WaveCanvas data={data} start={0} end={duration} mode="rgb" />
      {duration > 0 && <>
        <span className="viewport-window" style={{ left: `${100 * visibleStart / duration}%`, width: `${100 * (visibleEnd - visibleStart) / duration}%` }} />
        {loops.map(({ index, loop }) => <span key={index} className={`overview-loop ${loop.active ? "active" : ""}`} aria-hidden="true"
          style={{ left: `${100 * loop.start / duration}%`, width: `${100 * (loop.end - loop.start) / duration}%` }} />)}
        {cues.map((cue, index) => {
          const time = drag?.index === index && dragTime !== null ? dragTime : cue.time_seconds;
          const ratio = time / duration;
          return <span key={index} className={`overview-cue ${selected === index ? "selected" : ""} ${isLeadIn(cue) ? "lead-in-cue" : ""}`}
            style={{ left: `${100 * ratio}%` }}>
            <button type="button" className={ratio < 0.02 ? "at-start" : ratio > 0.98 ? "at-end" : ""}
              aria-label={`Seek to ${isLeadIn(cue) ? "lead-in " : ""}cue ${index + 1}: ${cue.label}, ${formatTime(time, true)}`}
              aria-pressed={selected === index} title={`${cue.label} · ${formatTime(time, true)}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => { select(index); seekTo(time); }}>{index + 1}</button>
          </span>;
        })}
        {preview !== null && <span className="overview-preview" style={{ left: `${100 * preview / duration}%` }} aria-hidden="true" />}
        <span className="overview-head" style={{ left: `${100 * currentPosition / duration}%` }} />
      </>}
    </div>
  </section>;
}
