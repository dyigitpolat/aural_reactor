import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PreviewEngine, type DiagnosticSnapshot } from "@/preview/PreviewEngine";
import { applyBakedToOverrides, type BakedModulation } from "@/preview/modulation";
import type { Clip, Cut, EffectChainEntry } from "@/api/client";
import { usePlayback } from "@/store/playback";
import { PreviewStatusOverlay } from "./PreviewStatusOverlay";

interface PreviewCanvasProps {
  clips: Clip[];
  edl: Cut[];
  audioUrl: string | null;
  baked: BakedModulation | null;
  effectChain: EffectChainEntry[];
  outputWidth: number;
  outputHeight: number;
  audioAnalyzed: boolean;
  bakeLoading?: boolean;
}

export function PreviewCanvas({
  clips,
  edl,
  audioUrl,
  baked,
  effectChain,
  outputWidth,
  outputHeight,
  audioAnalyzed,
  bakeLoading = false,
}: PreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const rafRef = useRef<number | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  const [diagnostics, setDiagnostics] = useState<DiagnosticSnapshot | null>(null);
  const [fitBox, setFitBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const setTime = usePlayback((s) => s.setTime);
  const setDuration = usePlayback((s) => s.setDuration);
  const playing = usePlayback((s) => s.playing);
  const setPlaying = usePlayback((s) => s.setPlaying);
  const setAudioEl = usePlayback((s) => s.setAudioEl);

  const bakedRef = useRef<BakedModulation | null>(baked);
  bakedRef.current = baked;

  // Mount: create engine, kick off init, start RAF loop, start diagnostics polling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    const engine = new PreviewEngine(canvas);
    engineRef.current = engine;

    // Init failures now surface through engine.getDiagnostics() → state →
    // the overlay. We still log to console for dev ergonomics.
    engine.init().catch((e) => {
      console.error("preview init failed:", e);
    });

    const ro = new ResizeObserver(() => {
      engine.resize(canvas.clientWidth, canvas.clientHeight);
    });
    ro.observe(canvas);
    // Kick a first sizing pass synchronously — ResizeObserver may be late.
    engine.resize(canvas.clientWidth, canvas.clientHeight);

    let lastT = -1;
    let lastPlaying = false;
    let needsRender = true;

    const loop = () => {
      if (cancelled) return;
      const audio = audioRef.current;
      const t = audio ? audio.currentTime : 0;
      const audioPlaying = audio ? !audio.paused && !audio.ended : false;

      // Only render when something changed: time moved, play state
      // toggled, or a fresh render was requested (resize, new data).
      const changed = audioPlaying || t !== lastT || audioPlaying !== lastPlaying || needsRender;
      lastT = t;
      lastPlaying = audioPlaying;
      needsRender = false;

      if (changed) {
        const b = bakedRef.current;
        if (b) {
          applyBakedToOverrides(b, t, engine.uniformOverrides);
        } else {
          engine.uniformOverrides.clear();
        }
        engine.render(t, audioPlaying);
        setTime(t);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    // Flag a render when the engine resizes or data changes.
    const markDirty = () => { needsRender = true; };
    ro.observe(canvas); // already observing, but the callback should mark dirty
    const origResize = engine.resize.bind(engine);
    engine.resize = (w: number, h: number) => { origResize(w, h); markDirty(); };

    // Poll diagnostics at 5 Hz — enough to feel live, cheap enough to ignore.
    const diagInterval = window.setInterval(() => {
      if (engineRef.current) {
        setDiagnostics(engineRef.current.getDiagnostics());
      }
    }, 200);

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.clearInterval(diagInterval);
      ro.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, [setTime]);

  // Register audio element with the store so Timeline/Topbar can seek.
  useEffect(() => {
    setAudioEl(audioRef.current);
    return () => setAudioEl(null);
  }, [setAudioEl]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setClips(clips.map((c) => ({ id: c.id, url: c.url, duration: c.duration })));
  }, [clips]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setEdl(edl);
  }, [edl]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setEffectChain(effectChain);
  }, [effectChain]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onMeta = () => setDuration(audio.duration || 0);
    const onEnded = () => setPlaying(false);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("ended", onEnded);
    };
  }, [setDuration, setPlaying]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      // First user-initiated play: try to re-prime any slot where autoplay
      // was blocked. After the user gesture, muted autoplay is allowed.
      const engine = engineRef.current;
      if (engine) void engine.retryPrimes();
      void audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  }, [playing, setPlaying]);

  // Letterbox/pillarbox: measure the parent pane and compute the largest
  // (w, h) rectangle that both fits inside the pane AND matches the project
  // aspect ratio. Runs on mount, on pane resize, and on project aspect change.
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane || outputWidth <= 0 || outputHeight <= 0) return;
    const target = outputWidth / outputHeight;

    const recompute = () => {
      const rect = pane.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const paneAspect = rect.width / rect.height;
      let w: number;
      let h: number;
      if (paneAspect > target) {
        // Pane wider than target → cap by height (pillarbox left/right).
        h = rect.height;
        w = h * target;
      } else {
        // Pane taller than target → cap by width (letterbox top/bottom).
        w = rect.width;
        h = w / target;
      }
      setFitBox({ w: Math.floor(w), h: Math.floor(h) });
    };

    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [outputWidth, outputHeight]);

  return (
    <div
      ref={paneRef}
      className="relative w-full h-full bg-black rounded-lg overflow-hidden surface grid place-items-center"
    >
      <div
        className="relative bg-black"
        style={{
          width: fitBox.w || 1,
          height: fitBox.h || 1,
        }}
      >
        <canvas ref={canvasRef} className="w-full h-full block" />
        <PreviewStatusOverlay
          diagnostics={diagnostics}
          hasAudio={!!audioUrl}
          clipCount={clips.length}
          audioAnalyzed={audioAnalyzed}
        />
        {bakeLoading && (
          <div className="absolute inset-0 grid place-items-center bg-black/40 z-30 pointer-events-none">
            <div className="flex items-center gap-2 bg-zinc-900/90 rounded-lg px-4 py-2 shadow-lg">
              <svg className="animate-spin h-4 w-4 text-accent" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
              </svg>
              <span className="text-xs text-zinc-300">Updating effects…</span>
            </div>
          </div>
        )}
      </div>
      <audio ref={audioRef} src={audioUrl ?? undefined} preload="auto" />
      {!audioUrl && clips.length === 0 && (
        <div className="absolute inset-0 grid place-items-center text-zinc-500 text-sm pointer-events-none">
          Upload audio and clips to begin
        </div>
      )}
    </div>
  );
}
