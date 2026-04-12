const CLIP_COLORS = [
  "#7c5cff", "#ff3d71", "#2bd4c3", "#fbbf24", "#f472b6",
  "#a78bfa", "#34d399", "#fb923c", "#60a5fa", "#e879f9",
];

export function clipColor(clipId: string): string {
  let hash = 0;
  for (let i = 0; i < clipId.length; i++) hash = (hash * 31 + clipId.charCodeAt(i)) | 0;
  return CLIP_COLORS[Math.abs(hash) % CLIP_COLORS.length];
}
