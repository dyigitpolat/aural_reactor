import {
  createFullscreenQuad,
  createGl,
  createProgram,
  createRenderTarget,
  createVideoTexture,
  DEFAULT_VERTEX_SHADER,
  type RenderTarget,
} from "./gl";

export interface EffectUniformSpec {
  name: string;
  param: string;
  default: number;
  min: number;
  max: number;
  description: string;
}

export interface EffectSpec {
  name: string;
  order: number;
  description: string;
  needs_prev_frame: boolean;
  uniforms: EffectUniformSpec[];
}

export interface EdlCut {
  t_start: number;
  t_end: number;
  clip_id: string;
  in_point: number;
  speed: number;
}

export interface PreviewClip {
  id: string;
  url: string;
  duration: number;
}

interface LoadedEffect {
  spec: EffectSpec;
  program: WebGLProgram;
  locations: Map<string, WebGLUniformLocation | null>;
  enabled: boolean;
  params: Record<string, number>;
}

interface SlotReadyFlags {
  metadata: boolean; // loadeddata fired
  primed: boolean; // requestVideoFrameCallback has fired at least once
}

interface VideoSlot {
  clip: PreviewClip;
  video: HTMLVideoElement;
  texture: WebGLTexture;
  readyFlags: SlotReadyFlags;
  lastError: string | null;
  primePromise: Promise<void> | null;
}

interface LoadedPrelude {
  program: WebGLProgram;
  uSrc: WebGLUniformLocation | null;
  uClipAspect: WebGLUniformLocation | null;
  uOutputAspect: WebGLUniformLocation | null;
}

type ChainEntryLite = { name: string; enabled: boolean; base_params: Record<string, number> };

// ─── Diagnostics ─────────────────────────────────────────────────────────

export type InitState =
  | { kind: "pending" }
  | { kind: "ready" }
  | { kind: "failed"; error: string };

export type FrameReason =
  | "ok"
  | "init-pending"
  | "init-failed"
  | "canvas-zero"
  | "no-cut"
  | "no-slot"
  | "slot-not-ready"
  | "slot-readystate-low"
  | "slot-seeking"
  | "upload-error";

export interface SlotDiagnostic {
  id: string;
  url: string;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  metadata: boolean;
  primed: boolean;
  lastError: string | null;
}

export interface DiagnosticSnapshot {
  initState: InitState;
  canvasSize: { w: number; h: number };
  activeCutId: string | null;
  activeCutTimecode: [number, number] | null;
  videoSlots: SlotDiagnostic[];
  framesRendered: number;
  framesSkipped: number;
  lastSkipReason: FrameReason;
  lastUploadError: string | null;
  edlCutCount: number;
}

// Debug clear colors — let the user visually see what state we're stuck in
// before they even open the overlay.
const CLEAR_COLORS: Record<FrameReason, [number, number, number]> = {
  ok: [0.0, 0.0, 0.0],
  "init-pending": [0.12, 0.08, 0.04], // dark amber
  "init-failed": [0.25, 0.04, 0.04], // dark red
  "canvas-zero": [0.05, 0.05, 0.05],
  "no-cut": [0.04, 0.06, 0.12], // dark indigo
  "no-slot": [0.08, 0.06, 0.03], // dark brown
  "slot-not-ready": [0.06, 0.06, 0.10], // dark slate
  "slot-readystate-low": [0.06, 0.08, 0.08], // dark teal
  "slot-seeking": [0.10, 0.08, 0.03], // dim gold
  "upload-error": [0.20, 0.05, 0.10], // dark pink
};


export class PreviewEngine {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private quadVao: WebGLVertexArrayObject;
  private effects: LoadedEffect[] = [];
  private prelude: LoadedPrelude | null = null;
  private videoSlots = new Map<string, VideoSlot>();
  private edl: EdlCut[] = [];
  private pingPong: [RenderTarget, RenderTarget] | null = null;
  private width = 0;
  private height = 0;
  private pendingChain: ChainEntryLite[] | null = null;
  private activeCutId: string | null = null;

  private initState: InitState = { kind: "pending" };
  private framesRendered = 0;
  private framesSkipped = 0;
  private lastSkipReason: FrameReason = "init-pending";
  private lastUploadError: string | null = null;
  private lastTimecode: [number, number] | null = null;

  public uniformOverrides: Map<string, Record<string, number>> = new Map();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.gl = createGl(canvas);
    this.quadVao = createFullscreenQuad(this.gl);
  }

  // ─── init ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    try {
      const [preludeFrag, effectsMeta] = await Promise.all([
        this.fetchShader("source_fit"),
        this.fetchEffectsMeta(),
      ]);

      const preludeProgram = createProgram(this.gl, DEFAULT_VERTEX_SHADER, preludeFrag);
      this.prelude = {
        program: preludeProgram,
        uSrc: this.gl.getUniformLocation(preludeProgram, "uSrc"),
        uClipAspect: this.gl.getUniformLocation(preludeProgram, "uClipAspect"),
        uOutputAspect: this.gl.getUniformLocation(preludeProgram, "uOutputAspect"),
      };

      // Parallel shader fetches instead of 13 sequential awaits.
      const fragments = await Promise.all(
        effectsMeta.effects.map((spec) =>
          this.fetchShader(spec.name).then((frag) => ({ spec, frag })),
        ),
      );

      for (const { spec, frag } of fragments) {
        const program = createProgram(this.gl, DEFAULT_VERTEX_SHADER, frag);
        const locations = new Map<string, WebGLUniformLocation | null>();
        for (const u of spec.uniforms) {
          locations.set(u.name, this.gl.getUniformLocation(program, u.name));
        }
        locations.set("uSrc", this.gl.getUniformLocation(program, "uSrc"));
        locations.set("uPrev", this.gl.getUniformLocation(program, "uPrev"));
        locations.set("uTime", this.gl.getUniformLocation(program, "uTime"));

        const params: Record<string, number> = {};
        for (const u of spec.uniforms) params[u.param] = u.default;

        this.effects.push({ spec, program, locations, enabled: true, params });
      }
      this.effects.sort((a, b) => a.spec.order - b.spec.order);

      this.resize(this.canvas.clientWidth, this.canvas.clientHeight);
      this.initState = { kind: "ready" };
      this.lastSkipReason = "ok";

      if (this.pendingChain) {
        this.setEffectChain(this.pendingChain);
        this.pendingChain = null;
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.initState = { kind: "failed", error };
      this.lastSkipReason = "init-failed";
      throw e;
    }
  }

  private async fetchShader(name: string): Promise<string> {
    const res = await fetch(`/api/effects/${name}.frag?target=webgl`);
    if (!res.ok) {
      throw new Error(`shader '${name}' fetch ${res.status} ${res.statusText}`);
    }
    return res.text();
  }

  private async fetchEffectsMeta(): Promise<{ order: string[]; effects: EffectSpec[] }> {
    const res = await fetch("/api/effects");
    if (!res.ok) throw new Error(`effects meta fetch ${res.status}`);
    return res.json();
  }

  // ─── resize ────────────────────────────────────────────────────────────

  resize(cssWidth: number, cssHeight: number): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.floor(cssWidth * dpr));
    const h = Math.max(2, Math.floor(cssHeight * dpr));
    if (w === this.width && h === this.height && this.pingPong) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.pingPong) {
      this.gl.deleteFramebuffer(this.pingPong[0].fbo);
      this.gl.deleteTexture(this.pingPong[0].tex);
      this.gl.deleteFramebuffer(this.pingPong[1].fbo);
      this.gl.deleteTexture(this.pingPong[1].tex);
    }
    this.pingPong = [
      createRenderTarget(this.gl, w, h),
      createRenderTarget(this.gl, w, h),
    ];
  }

  // ─── clips / prime ─────────────────────────────────────────────────────

  setClips(clips: PreviewClip[]): void {
    const nextIds = new Set(clips.map((c) => c.id));
    for (const [id, slot] of this.videoSlots) {
      if (!nextIds.has(id)) {
        slot.video.src = "";
        slot.video.load();
        this.gl.deleteTexture(slot.texture);
        this.videoSlots.delete(id);
      }
    }
    for (const clip of clips) {
      if (this.videoSlots.has(clip.id)) continue;
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.loop = false;
      // Deliberately NOT setting crossOrigin="anonymous" — the backend serves
      // /media through the same origin as the frontend (vite proxy), and
      // setting crossOrigin with a non-CORS response taints the video and
      // makes texImage2D throw SECURITY_ERR.

      const slot: VideoSlot = {
        clip,
        video,
        texture: createVideoTexture(this.gl),
        readyFlags: { metadata: false, primed: false },
        lastError: null,
        primePromise: null,
      };

      video.addEventListener("loadeddata", () => {
        slot.readyFlags.metadata = true;
        this.primeSlot(slot);
      });
      video.addEventListener("error", () => {
        const err = video.error;
        slot.lastError = err
          ? `MEDIA_ERR_${err.code} ${err.message}`.trim()
          : "unknown video error";
      });

      video.src = clip.url;
      video.load();
      this.videoSlots.set(clip.id, slot);
    }
  }

  /**
   * Materialize the first video frame into the element's internal buffer so
   * subsequent texImage2D calls return real pixels.
   *
   * We try requestVideoFrameCallback (fires when a frame is composited) with
   * a generous 6s ceiling, but if it never fires we DON'T fail the slot —
   * we fall back to a plain setTimeout and mark the slot primed optimistically.
   * Most videos have a usable frame by then even if rVFC is silent.
   */
  private primeSlot(slot: VideoSlot): Promise<void> {
    if (slot.primePromise) return slot.primePromise;
    const video = slot.video;

    const promise = (async () => {
      try {
        await video.play();
      } catch {
        // Autoplay blocked — retry on first user gesture. Leave primed=false.
        slot.readyFlags.primed = false;
        slot.lastError = "autoplay blocked (retrying on play click)";
        slot.primePromise = null;
        return;
      }

      await new Promise<void>((resolve) => {
        const anyVideo = video as HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number;
        };
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        if (typeof anyVideo.requestVideoFrameCallback === "function") {
          anyVideo.requestVideoFrameCallback(finish);
        }
        // Belt-and-braces fallback: even if rVFC is silent for this clip
        // (e.g. long decode, Safari hiccup), proceed after 400ms. The
        // video element almost always has a usable frame by then.
        setTimeout(finish, 400);
      });

      try {
        video.pause();
      } catch {
        /* ignore */
      }
      slot.readyFlags.primed = true;
      slot.lastError = null;
    })();

    slot.primePromise = promise;
    return promise;
  }

  /**
   * Retry the prime for any slot where autoplay was blocked. Called from the
   * UI on first user interaction (Play click) — by that point the muted
   * autoplay policy reliably permits playback.
   */
  async retryPrimes(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const slot of this.videoSlots.values()) {
      if (!slot.readyFlags.primed && slot.readyFlags.metadata) {
        pending.push(this.primeSlot(slot));
      }
    }
    await Promise.allSettled(pending);
  }

  // ─── edl / chain ───────────────────────────────────────────────────────

  setEdl(edl: EdlCut[]): void {
    this.edl = edl.slice().sort((a, b) => a.t_start - b.t_start);
  }

  setEnabled(effectName: string, enabled: boolean): void {
    const e = this.effects.find((ef) => ef.spec.name === effectName);
    if (e) e.enabled = enabled;
  }

  setParam(effectName: string, param: string, value: number): void {
    const e = this.effects.find((ef) => ef.spec.name === effectName);
    if (!e) return;
    e.params[param] = value;
  }

  setEffectChain(chain: ChainEntryLite[]): void {
    if (this.initState.kind !== "ready") {
      this.pendingChain = chain;
      return;
    }
    // Map chain entries by name; effects not in the chain are disabled.
    const byName = new Map(chain.map((c) => [c.name, c]));
    for (const e of this.effects) {
      const entry = byName.get(e.spec.name);
      if (entry) {
        e.enabled = entry.enabled;
        for (const u of e.spec.uniforms) {
          e.params[u.param] = entry.base_params[u.param] ?? u.default;
        }
      } else {
        e.enabled = false;
      }
    }
  }

  // ─── render ────────────────────────────────────────────────────────────

  private effectiveParam(effect: LoadedEffect, uniform: EffectUniformSpec): number {
    const override = this.uniformOverrides.get(effect.spec.name)?.[uniform.param];
    const base = effect.params[uniform.param] ?? uniform.default;
    // Max-combine with the base chain value instead of replacing it.
    // Between rhythmic hits the patch envelope decays to 0, and the previous
    // "override replaces base" path wiped the cinematic baseline to zero —
    // contrast_pump would drop from 0.32 to 0 every frame no kick fired,
    // killing the audio-reactive look entirely. max(base, override) keeps
    // the baseline floor visible AND lets punches push intensity higher.
    const raw = override !== undefined ? Math.max(base, override) : base;
    return Math.max(uniform.min, Math.min(uniform.max, raw));
  }

  private activeCut(time: number): EdlCut | null {
    if (this.edl.length === 0) return null;
    let lo = 0;
    let hi = this.edl.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.edl[mid].t_start <= time) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const cut = this.edl[found];
    if (cut && time >= cut.t_start && time < cut.t_end) return cut;
    return null;
  }

  private lastPrefetchId: string | null = null;

  private prefetchNext(time: number): void {
    // Find the next cut after the current time and pre-seek its video
    // so the browser buffers ahead. Throttle: only act when the next
    // clip changes.
    let nextCut: EdlCut | null = null;
    for (const c of this.edl) {
      if (c.t_start > time + 0.01) {
        nextCut = c;
        break;
      }
    }
    if (!nextCut || nextCut.clip_id === this.lastPrefetchId) return;
    this.lastPrefetchId = nextCut.clip_id;

    const slot = this.videoSlots.get(nextCut.clip_id);
    if (!slot || !slot.readyFlags.metadata) return;

    const targetTime = nextCut.in_point;
    if (Math.abs(slot.video.currentTime - targetTime) > 1) {
      slot.video.currentTime = targetTime;
    }
  }

  private syncVideoToClip(
    slot: VideoSlot,
    clipTime: number,
    audioPlaying: boolean,
    speed: number,
    cutChanged: boolean,
  ): void {
    if (!slot.readyFlags.metadata) return;
    const video = slot.video;
    // Loop gracefully: when clipTime exceeds the source clip, wrap around.
    let effective = clipTime;
    if (video.duration > 0.1 && effective > video.duration) {
      effective = effective % video.duration;
    }
    const target = Math.max(0, Math.min(Math.max(0.01, video.duration - 0.01), effective));

    if (cutChanged) {
      video.currentTime = target;
      if (audioPlaying) {
        if (video.playbackRate !== speed) video.playbackRate = speed;
        if (video.paused) void video.play().catch(() => {});
      } else if (!video.paused) {
        video.pause();
      }
      return;
    }

    if (audioPlaying) {
      if (video.playbackRate !== speed) video.playbackRate = speed;
      if (video.paused) void video.play().catch(() => {});
      if (Math.abs(video.currentTime - target) > 0.4) {
        video.currentTime = target;
      }
    } else if (!video.paused) {
      video.pause();
    }
  }

  /** Paint the canvas to a state-specific debug color and record the skip. */
  /**
   * Skip reasons that are short-lived and should NOT repaint the canvas
   * during normal playback — repainting causes visible blinking as the
   * engine flickers between real video frames and the debug background.
   * We preserve the last rendered frame until we've been in a non-ok
   * state for more than one frame.
   */
  private static readonly TRANSIENT_REASONS: Set<FrameReason> = new Set([
    "slot-seeking",
    "slot-readystate-low",
    "slot-not-ready",
    "upload-error",
    "no-slot",
  ]);

  private skipFrame(reason: FrameReason): void {
    this.lastSkipReason = reason;
    this.framesSkipped += 1;
    const gl = this.gl;
    if (this.width < 2 || this.height < 2) return;

    // If we already rendered at least one real frame and the reason is
    // something that will likely recover next tick, leave the canvas alone
    // so the last good frame stays visible.
    const isTransient = PreviewEngine.TRANSIENT_REASONS.has(reason);
    if (isTransient && this.framesRendered > 0) {
      return;
    }

    const [r, g, b] = CLEAR_COLORS[reason] ?? CLEAR_COLORS["no-cut"];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(r, g, b, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  render(time: number, audioPlaying: boolean): void {
    const gl = this.gl;

    // Init state gates everything.
    if (this.initState.kind === "pending") {
      this.skipFrame("init-pending");
      return;
    }
    if (this.initState.kind === "failed") {
      this.skipFrame("init-failed");
      return;
    }
    if (!this.pingPong || !this.prelude) {
      this.skipFrame("init-pending");
      return;
    }
    if (this.width < 2 || this.height < 2) {
      this.lastSkipReason = "canvas-zero";
      this.framesSkipped += 1;
      return;
    }

    gl.bindVertexArray(this.quadVao);
    gl.viewport(0, 0, this.width, this.height);

    const cut = this.activeCut(time);
    const cutChanged = (cut?.clip_id ?? null) !== this.activeCutId;
    this.activeCutId = cut?.clip_id ?? null;

    // Lookahead: find the next cut and pre-seek its video so the browser
    // buffers a few seconds ahead. Only the current + next clip buffer;
    // all others stay at metadata-only.
    this.prefetchNext(time);

    if (!cut) {
      this.lastTimecode = null;
      this.skipFrame("no-cut");
      return;
    }

    const slot = this.videoSlots.get(cut.clip_id);
    if (!slot) {
      this.lastTimecode = null;
      this.skipFrame("no-slot");
      return;
    }

    const clipTime = cut.in_point + (time - cut.t_start) * cut.speed;
    this.lastTimecode = [cut.t_start, clipTime];
    this.syncVideoToClip(slot, clipTime, audioPlaying, cut.speed, cutChanged);

    if (!slot.readyFlags.metadata) {
      this.skipFrame("slot-not-ready");
      return;
    }
    if (slot.video.readyState < 2) {
      this.skipFrame("slot-readystate-low");
      return;
    }
    if (slot.video.seeking) {
      this.skipFrame("slot-seeking");
      return;
    }

    // ─── Upload ─────────────────────────────────────────────────────────
    let clipW = 16;
    let clipH = 9;
    gl.bindTexture(gl.TEXTURE_2D, slot.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, slot.video,
      );
      this.lastUploadError = null;
    } catch (e) {
      this.lastUploadError = e instanceof Error ? e.message : String(e);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      this.skipFrame("upload-error");
      return;
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (slot.video.videoWidth > 0 && slot.video.videoHeight > 0) {
      clipW = slot.video.videoWidth;
      clipH = slot.video.videoHeight;
    }

    const srcTex = slot.texture;
    // Time-based effects (shake, glitch, grain, etc.) use the audio playhead
    // so they freeze when audio is paused and jump on seek — visually
    // consistent with what the user is hearing.
    const t = time;
    const clipAspect = clipW / clipH;
    const outputAspect = this.width / this.height;

    // ─── Source-fit prelude ─────────────────────────────────────────────
    const preFbo = this.pingPong[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, preFbo.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.prelude.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(this.prelude.uSrc, 0);
    gl.uniform1f(this.prelude.uClipAspect, clipAspect);
    gl.uniform1f(this.prelude.uOutputAspect, outputAspect);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // ─── User effect chain ──────────────────────────────────────────────
    let read = preFbo.tex;
    let writeIdx = 1;
    const activeEffects = this.effects.filter((e) => e.enabled);

    if (activeEffects.length === 0) {
      // No user effects — copy prelude output to canvas via an identity pass.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.width, this.height);
      gl.useProgram(this.prelude.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, preFbo.tex);
      gl.uniform1i(this.prelude.uSrc, 0);
      gl.uniform1f(this.prelude.uClipAspect, 1.0);
      gl.uniform1f(this.prelude.uOutputAspect, 1.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
      this.framesRendered += 1;
      this.lastSkipReason = "ok";
      return;
    }

    for (let i = 0; i < activeEffects.length; i++) {
      const e = activeEffects[i];
      const last = i === activeEffects.length - 1;
      const target = last ? null : this.pingPong[writeIdx];

      if (target) gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.width, this.height);
      gl.useProgram(e.program);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, read);
      gl.uniform1i(e.locations.get("uSrc") ?? null, 0);
      gl.uniform1f(e.locations.get("uTime") ?? null, t);

      if (e.spec.needs_prev_frame) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.pingPong[1 - writeIdx].tex);
        gl.uniform1i(e.locations.get("uPrev") ?? null, 1);
      }

      for (const u of e.spec.uniforms) {
        const loc = e.locations.get(u.name);
        if (loc === undefined || loc === null) continue;
        gl.uniform1f(loc, this.effectiveParam(e, u));
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      if (target) {
        read = target.tex;
        writeIdx = 1 - writeIdx;
      }
    }

    gl.bindVertexArray(null);
    this.framesRendered += 1;
    this.lastSkipReason = "ok";
  }

  // ─── diagnostics ───────────────────────────────────────────────────────

  getDiagnostics(): DiagnosticSnapshot {
    const slots: SlotDiagnostic[] = [];
    for (const slot of this.videoSlots.values()) {
      slots.push({
        id: slot.clip.id,
        url: slot.clip.url,
        readyState: slot.video.readyState,
        videoWidth: slot.video.videoWidth,
        videoHeight: slot.video.videoHeight,
        metadata: slot.readyFlags.metadata,
        primed: slot.readyFlags.primed,
        lastError: slot.lastError,
      });
    }
    return {
      initState: this.initState,
      canvasSize: { w: this.width, h: this.height },
      activeCutId: this.activeCutId,
      activeCutTimecode: this.lastTimecode,
      videoSlots: slots,
      framesRendered: this.framesRendered,
      framesSkipped: this.framesSkipped,
      lastSkipReason: this.lastSkipReason,
      lastUploadError: this.lastUploadError,
      edlCutCount: this.edl.length,
    };
  }

  destroy(): void {
    const gl = this.gl;
    if (this.prelude) {
      gl.deleteProgram(this.prelude.program);
      this.prelude = null;
    }
    for (const e of this.effects) gl.deleteProgram(e.program);
    for (const slot of this.videoSlots.values()) {
      slot.video.src = "";
      slot.video.load();
      gl.deleteTexture(slot.texture);
    }
    if (this.pingPong) {
      gl.deleteFramebuffer(this.pingPong[0].fbo);
      gl.deleteTexture(this.pingPong[0].tex);
      gl.deleteFramebuffer(this.pingPong[1].fbo);
      gl.deleteTexture(this.pingPong[1].tex);
    }
    gl.deleteVertexArray(this.quadVao);
  }

  getEffects(): LoadedEffect[] {
    return this.effects;
  }
}
