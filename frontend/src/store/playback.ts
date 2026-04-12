import { create } from "zustand";

interface PlaybackState {
  playing: boolean;
  currentTime: number;
  duration: number;
  audioEl: HTMLAudioElement | null;

  setAudioEl: (el: HTMLAudioElement | null) => void;
  setPlaying: (p: boolean) => void;
  setTime: (t: number) => void;
  setDuration: (d: number) => void;
  seek: (t: number) => void;
  togglePlay: () => void;
}

export const usePlayback = create<PlaybackState>((set, get) => ({
  playing: false,
  currentTime: 0,
  duration: 0,
  audioEl: null,

  setAudioEl: (el) => set({ audioEl: el }),
  setPlaying: (p) => set({ playing: p }),
  setTime: (t) => set({ currentTime: t }),
  setDuration: (d) => set({ duration: d }),

  seek: (t) => {
    const audio = get().audioEl;
    if (audio && Number.isFinite(t)) {
      const clamped = Math.max(0, Math.min(audio.duration || t, t));
      audio.currentTime = clamped;
      set({ currentTime: clamped });
    } else {
      set({ currentTime: t });
    }
  },

  togglePlay: () => {
    const { playing, audioEl } = get();
    const next = !playing;
    set({ playing: next });
    if (audioEl) {
      if (next) void audioEl.play().catch(() => set({ playing: false }));
      else audioEl.pause();
    }
  },
}));
