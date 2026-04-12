/** Binary-search the nearest beat to `t` within `thresholdSeconds`.
 *
 * Returns the snapped time if a beat is within range, otherwise `t` unchanged.
 */
export function snapToBeat(
  t: number,
  beats: number[],
  thresholdSeconds = 0.12,
): number {
  if (beats.length === 0 || !Number.isFinite(t)) return t;

  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first beat >= t. Check lo and lo-1 for nearest.
  const candidates: number[] = [];
  if (lo < beats.length) candidates.push(beats[lo]);
  if (lo > 0) candidates.push(beats[lo - 1]);
  if (candidates.length === 0) return t;

  let bestBeat = candidates[0];
  let bestDist = Math.abs(bestBeat - t);
  for (let i = 1; i < candidates.length; i++) {
    const d = Math.abs(candidates[i] - t);
    if (d < bestDist) {
      bestDist = d;
      bestBeat = candidates[i];
    }
  }
  return bestDist <= thresholdSeconds ? bestBeat : t;
}
