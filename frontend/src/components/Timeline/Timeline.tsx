import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { ChevronDown, ChevronRight, Magnet } from "lucide-react";
import clsx from "clsx";
import { usePlayback } from "@/store/playback";
import type { AnalyzeSummary, Clip, Cut } from "@/api/client";
import { SignalLane } from "./SignalLane";
import { EventLane } from "./EventLane";
import { ClipStrip } from "./ClipStrip";
import { PlayheadCursor } from "./PlayheadCursor";

interface TimelineProps {
  projectId: string | null;
  audioUrl: string | null;
  summary: AnalyzeSummary | null;
  beatTimes: number[];
  downbeatTimes: number[];
  edl: Cut[];
  clips: Clip[];
}

interface SignalRowSpec {
  name: string;
  label: string;
  color: string;
}

interface EventRowSpec {
  key: string;
  label: string;
  color: string;
}

function pickSignalRows(summary: AnalyzeSummary | null): SignalRowSpec[] {
  if (!summary) return [];
  const keys = new Set(summary.continuous_keys);
  const has = (k: string) => keys.has(k);
  const rows: SignalRowSpec[] = [
    { name: "rms", label: "rms", color: "#a1a1aa" },
  ];
  if (has("drums_rms")) rows.push({ name: "drums_rms", label: "drums", color: "#ff3d71" });
  else if (has("percussiveness")) rows.push({ name: "percussiveness", label: "perc", color: "#ff3d71" });
  if (has("bass_rms")) rows.push({ name: "bass_rms", label: "bass", color: "#7c5cff" });
  else if (has("bass_energy")) rows.push({ name: "bass_energy", label: "bass", color: "#7c5cff" });
  if (has("vocals_rms")) rows.push({ name: "vocals_rms", label: "vocals", color: "#2bd4c3" });
  else if (has("harmonicity")) rows.push({ name: "harmonicity", label: "harm", color: "#2bd4c3" });
  if (has("spectral_flux")) rows.push({ name: "spectral_flux", label: "flux", color: "#fbbf24" });
  if (has("treble_energy")) rows.push({ name: "treble_energy", label: "treble", color: "#f472b6" });
  return rows;
}

function pickEventRows(summary: AnalyzeSummary | null): EventRowSpec[] {
  if (!summary) return [];
  const events = summary.events || {};
  const has = (k: string) => Array.isArray(events[k]) && events[k].length > 0;
  const rows: EventRowSpec[] = [];
  if (has("drop_detected")) rows.push({ key: "drop_detected", label: "drop", color: "#a78bfa" });
  return rows;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 32;
// Log2 mapping: slider value in [0, 1] → zoom in [1, 32]. 1 → 1×, 0.2 → 2×,
// 0.4 → 4×, 0.6 → 8×, 0.8 → 16×, 1.0 → 32×. Linear zoom feels terrible for
// time scales — doubling is the natural perceptual unit.
const zoomFromSlider = (v: number): number => MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, v);
const sliderFromZoom = (z: number): number =>
  Math.log(z / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM);

// Left-side label gutter width (pixels). Keeps "rms", "bass" etc. labels
// static while the time-scale scrolls horizontally.
const LABEL_GUTTER_PX = 72;

export function Timeline({
  projectId,
  audioUrl,
  summary,
  beatTimes,
  downbeatTimes,
  edl,
  clips,
}: TimelineProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const wavesurferContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [signalsOpen, setSignalsOpen] = useState(true);
  const [selectedCutIndex, setSelectedCutIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [snapOn, setSnapOn] = useState(true);
  const [baseWidth, setBaseWidth] = useState(800);

  // Measure the content area (scroller width minus the label gutter) so
  // totalWidth at zoom=1 fits exactly. Re-measures on window resize.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const recompute = () => {
      const w = el.clientWidth - LABEL_GUTTER_PX;
      if (w > 0) setBaseWidth(w);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const duration = summary?.duration ?? 0;
  const totalWidth = Math.max(baseWidth, Math.floor(baseWidth * zoom));
  const pxPerSecond = duration > 0 ? totalWidth / duration : 0;

  // Wavesurfer init. We keep `fillParent: true` as the baseline so the
  // initial render fits the container, then call `ws.zoom(pxPerSec)` any
  // time the zoom slider changes so the waveform's pixel density exactly
  // matches the shared time scale used by the clip strip + signal lanes.
  useEffect(() => {
    if (!wavesurferContainerRef.current || !audioUrl) return;
    const ws = WaveSurfer.create({
      container: wavesurferContainerRef.current,
      height: 56,
      waveColor: "#3f3f46",
      progressColor: "#7c5cff",
      cursorColor: "transparent",
      cursorWidth: 0,
      barWidth: 1,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      interact: true,
      fillParent: true,
    });
    ws.load(audioUrl);
    wsRef.current = ws;

    ws.on("click", (p: number) => {
      const dur = ws.getDuration();
      if (dur > 0) usePlayback.getState().seek(dur * p);
    });

    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [audioUrl]);

  // Keep the waveform's minPxPerSec in lockstep with the shared scale.
  // Without this, WaveSurfer renders once at the container width on load
  // and then drifts out of sync with the clip strip whenever the user
  // changes the zoom slider. We wait for `ready` before the first zoom
  // because calling zoom() before the audio decodes is a no-op.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || pxPerSecond <= 0) return;
    const applyZoom = () => {
      try {
        ws.zoom(pxPerSecond);
      } catch {
        // wavesurfer throws if called mid-load — ignore; the next effect
        // run (after zoom slider moves again) will recover.
      }
    };
    if (ws.getDuration() > 0) {
      applyZoom();
      return;
    }
    const onReady = () => applyZoom();
    ws.on("ready", onReady);
    return () => {
      ws.un("ready", onReady);
    };
  }, [pxPerSecond, audioUrl]);

  // Drive wavesurfer cursor from the real audio element (live while playing).
  useEffect(() => {
    const audio = usePlayback.getState().audioEl;
    if (!audio) return;
    let raf = 0;
    const tick = () => {
      const ws = wsRef.current;
      const d = ws?.getDuration() ?? 0;
      if (ws && d > 0) {
        ws.seekTo(Math.min(1, Math.max(0, audio.currentTime / d)));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [audioUrl]);

  const signalRows = useMemo(() => pickSignalRows(summary), [summary]);
  const eventRows = useMemo(() => pickEventRows(summary), [summary]);

  return (
    <div className="surface rounded-lg px-3 py-2 flex flex-col gap-1 max-h-full">
      {/* Header: stats + zoom controls (outside the scroller) */}
      <div className="flex items-center gap-3 text-[10px] text-zinc-500 tabular-nums shrink-0">
        {summary && (
          <>
            <span>{summary.tempo_bpm.toFixed(1)} BPM</span>
            <span>{summary.beat_count} beats</span>
            <span>{summary.downbeat_count} bars</span>
            <span>{summary.section_count} sections</span>
            {summary.has_stems && <span className="text-accent">stems</span>}
          </>
        )}
        <span className="ml-auto">{edl.length} cuts</span>
        <button
          onClick={() => setSnapOn((v) => !v)}
          className={clsx(
            "h-5 px-1.5 rounded flex items-center gap-1 text-[9px] transition-colors ml-2",
            snapOn
              ? "bg-accent/30 text-accent border border-accent/60"
              : "bg-zinc-900 text-zinc-500 border border-zinc-800 hover:text-zinc-300",
          )}
          title="Snap edits to nearest beat (hold Shift to disable)"
        >
          <Magnet className="h-2.5 w-2.5" />
          snap
        </button>
        <div className="flex items-center gap-1.5 ml-2 shrink-0">
          <span className="text-zinc-600 text-[9px]">zoom</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={sliderFromZoom(zoom)}
            onChange={(e) => setZoom(zoomFromSlider(parseFloat(e.target.value)))}
            className="w-32 accent-accent cursor-pointer"
            title={`${zoom < 2 ? zoom.toFixed(1) : Math.round(zoom)}× zoom`}
          />
          <span className="font-mono tabular-nums w-9 text-right text-zinc-400">
            {zoom < 2 ? zoom.toFixed(1) : Math.round(zoom)}×
          </span>
        </div>
      </div>

      {/* Single horizontal scroller shared by waveform, signal lanes, clip strip.
          Everything inside uses the same pxPerSecond so rows stay vertically
          aligned to the same song time. */}
      <div
        ref={scrollerRef}
        className="relative overflow-x-auto overflow-y-hidden min-h-0"
      >
        <div className="flex" style={{ width: LABEL_GUTTER_PX + totalWidth }}>
          {/* Left: label gutter — sticky so labels stay visible when scrolling */}
          <div
            className="flex flex-col shrink-0 sticky left-0 z-20 bg-zinc-950/90 backdrop-blur-sm"
            style={{ width: LABEL_GUTTER_PX }}
          >
            <div style={{ height: 56 }} />
            {summary && summary.sections.length > 0 && (
              <div className="flex items-center pl-1 text-[8px] uppercase tracking-wider text-zinc-600" style={{ height: 14 }}>
                sections
              </div>
            )}
            <div className="flex items-center pl-1 text-[9px] uppercase tracking-wider text-zinc-500" style={{ height: 86 }}>
              clips
            </div>
            {signalsOpen && signalRows.map((row) => (
              <div
                key={`lbl-${row.name}`}
                className="flex items-center pl-2 text-[10px] font-mono text-zinc-500 truncate"
                style={{ height: 22 }}
              >
                {row.label}
              </div>
            ))}
            {signalsOpen && eventRows.length > 0 && <div style={{ height: 4 }} />}
            {signalsOpen && eventRows.map((row) => (
              <div
                key={`evlbl-${row.key}`}
                className="flex items-center pl-2 text-[10px] font-mono text-zinc-500 truncate"
                style={{ height: 14 }}
              >
                {row.label}
              </div>
            ))}
          </div>

          {/* Right: scrollable time-scaled content */}
          <div className="relative flex flex-col" style={{ width: totalWidth }}>
            {/* Shared playhead line — spans all rows, driven by audio.currentTime */}
            {pxPerSecond > 0 && <PlayheadCursor pxPerSecond={pxPerSecond} />}
            {/* Waveform + beat tick overlay */}
            <div className="relative" style={{ width: totalWidth, height: 56 }}>
              <div
                ref={wavesurferContainerRef}
                className="absolute inset-0"
                style={{ width: totalWidth }}
              />
              {duration > 0 && (
                <svg
                  className="absolute inset-0 w-full h-full pointer-events-none"
                  preserveAspectRatio="none"
                  viewBox={`0 0 ${duration} 1`}
                >
                  {beatTimes.map((t, i) => (
                    <line
                      key={`b${i}`}
                      x1={t}
                      x2={t}
                      y1={0.75}
                      y2={1.0}
                      stroke="#a1a1aa"
                      strokeWidth={duration / (totalWidth * 0.5)}
                    />
                  ))}
                  {downbeatTimes.map((t, i) => (
                    <line
                      key={`d${i}`}
                      x1={t}
                      x2={t}
                      y1={0}
                      y2={1}
                      stroke="#ff3d71"
                      strokeWidth={duration / (totalWidth * 0.4)}
                    />
                  ))}
                </svg>
              )}
            </div>

            {/* Section labels + color bar above clip strip */}
            {summary && summary.sections.length > 0 && pxPerSecond > 0 && (
              <div className="relative shrink-0" style={{ width: totalWidth, height: 14 }}>
                {summary.sections.map((sec, i) => {
                  const left = sec.start * pxPerSecond;
                  const w = (sec.end - sec.start) * pxPerSecond;
                  const hue = Math.round(240 - sec.energy * 240);
                  return (
                    <div
                      key={i}
                      className="absolute top-0 h-full flex items-center overflow-hidden"
                      style={{
                        left,
                        width: w,
                        background: `hsla(${hue}, 50%, 30%, 0.35)`,
                        borderLeft: i > 0 ? `1px solid hsla(${hue}, 50%, 50%, 0.4)` : undefined,
                      }}
                    >
                      {w > 20 && (
                        <span className="px-1.5 text-[8px] font-mono text-zinc-300/80 truncate">
                          {sec.label}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Clip strip */}
            {duration > 0 && (
              <ClipStrip
                projectId={projectId}
                clips={clips}
                edl={edl}
                duration={duration}
                beats={beatTimes}
                selectedIndex={selectedCutIndex}
                onSelect={setSelectedCutIndex}
                pxPerSecond={pxPerSecond}
                totalWidth={totalWidth}
                snapOn={snapOn}
              />
            )}

            {/* Signal + event lanes */}
            {summary && signalsOpen && (
              <>
                {signalRows.map((row) => (
                  <div
                    key={row.name}
                    style={{ width: totalWidth, height: 22 }}
                    className="shrink-0"
                  >
                    <SignalLane
                      projectId={projectId}
                      name={row.name}
                      label=""
                      color={row.color}
                    />
                  </div>
                ))}
                {eventRows.length > 0 && <div className="h-1" />}
                {eventRows.map((row) => (
                  <div
                    key={row.key}
                    style={{ width: totalWidth, height: 14 }}
                    className="shrink-0"
                  >
                    <EventLane
                      label=""
                      events={summary.events[row.key] ?? []}
                      duration={duration}
                      color={row.color}
                    />
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Signal toggle */}
      {summary && (signalRows.length > 0 || eventRows.length > 0) && (
        <button
          onClick={() => setSignalsOpen((v) => !v)}
          className={clsx(
            "flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition-colors shrink-0",
          )}
        >
          {signalsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Signals · {signalRows.length} continuous · {eventRows.length} events
        </button>
      )}
    </div>
  );
}
