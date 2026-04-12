/** Decodes the packed modulation blob from /api/routing/:id/bake. */

export interface BakedModulation {
  rateHz: number;
  duration: number;
  nFrames: number;
  targets: Map<string, Float32Array>;
}

export function decodeBake(buf: ArrayBuffer): BakedModulation {
  const view = new DataView(buf);
  let off = 0;
  const nTargets = view.getUint32(off, true);
  off += 4;
  const nFrames = view.getUint32(off, true);
  off += 4;
  const rateHz = view.getFloat32(off, true);
  off += 4;
  const duration = view.getFloat32(off, true);
  off += 4;

  const targets = new Map<string, Float32Array>();
  const decoder = new TextDecoder();
  for (let i = 0; i < nTargets; i++) {
    const nameLen = view.getUint16(off, true);
    off += 2;
    const nameBytes = new Uint8Array(buf, off, nameLen);
    const name = decoder.decode(nameBytes);
    off += nameLen;
    const arr = new Float32Array(buf.slice(off, off + nFrames * 4));
    off += nFrames * 4;
    targets.set(name, arr);
  }
  return { rateHz, duration, nFrames, targets };
}

export function sampleBaked(baked: BakedModulation, target: string, t: number): number {
  const arr = baked.targets.get(target);
  if (!arr || arr.length === 0) return 0;
  const idx = Math.max(0, Math.min(arr.length - 1, Math.round(t * baked.rateHz)));
  return arr[idx];
}

/** Apply the baked modulation to PreviewEngine.uniformOverrides, absolute-set style. */
export function applyBakedToOverrides(
  baked: BakedModulation,
  t: number,
  overrides: Map<string, Record<string, number>>,
): void {
  // Clear previous frame's overrides
  overrides.clear();
  for (const [target, arr] of baked.targets) {
    const dot = target.indexOf(".");
    if (dot < 0) continue;
    const effect = target.slice(0, dot);
    const param = target.slice(dot + 1);
    const idx = Math.max(0, Math.min(arr.length - 1, Math.round(t * baked.rateHz)));
    const v = arr[idx];
    let group = overrides.get(effect);
    if (!group) {
      group = {};
      overrides.set(effect, group);
    }
    // Baked values are absolute parameter values, not deltas — overwrite base.
    group[param] = v;
  }
}
