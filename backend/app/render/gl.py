"""Headless ModernGL effect chain. Python mirror of the browser PreviewEngine.

Uses moderngl.create_standalone_context() which picks up the system's OpenGL.
On macOS this hits the 4.1 compat profile via Apple's GL layer, which satisfies
our GLSL 330 core shaders.

Orientation: frames are np.flipud'd before texture.write so texel y=0 holds
the visual bottom of the image. This matches the browser's UNPACK_FLIP_Y_WEBGL
convention — both engines see identical texture memory and produce identical
output. The final readback is flipped once so the returned ndarray has row 0
at the top of the image in the usual numpy sense.
"""
from __future__ import annotations

import logging

import moderngl
import numpy as np

from backend.app.project.models import EffectChainEntry
from backend.app.routing.matrix import BakedModulation
from backend.app.video.effects import (
    EFFECTS,
    SOURCE_FIT_SPEC,
    EffectSpec,
    MODERNGL_VERTEX,
    build_fragment,
)

log = logging.getLogger(__name__)

# Fullscreen triangle-strip quad: (x, y, u, v)
_QUAD_DATA = np.array(
    [
        [-1.0, -1.0, 0.0, 0.0],
        [1.0, -1.0, 1.0, 0.0],
        [-1.0, 1.0, 0.0, 1.0],
        [1.0, 1.0, 1.0, 1.0],
    ],
    dtype=np.float32,
)


class _LoadedEffect:
    def __init__(self, ctx: moderngl.Context, spec: EffectSpec, quad_vbo: moderngl.Buffer):
        self.spec = spec
        self.program = ctx.program(
            vertex_shader=MODERNGL_VERTEX.strip(),
            fragment_shader=build_fragment(spec.name, "gl"),
        )
        self.vao = ctx.vertex_array(
            self.program, [(quad_vbo, "2f 2f", "aPos", "aUv")]
        )
        self.enabled = True
        self.base_params: dict[str, float] = {u.param: u.default for u in spec.uniforms}

    def set_uniform(self, name: str, value) -> None:
        if name in self.program:
            self.program[name].value = value

    def release(self) -> None:
        self.vao.release()
        self.program.release()


class EffectChainGL:
    def __init__(self, width: int, height: int):
        self.ctx = moderngl.create_standalone_context(require=330)
        self.width = width
        self.height = height
        self.quad_vbo = self.ctx.buffer(_QUAD_DATA.tobytes())

        # Mandatory prelude: source_fit.
        self.prelude = _LoadedEffect(self.ctx, SOURCE_FIT_SPEC, self.quad_vbo)

        # User effect programs.
        self.effects: list[_LoadedEffect] = [
            _LoadedEffect(self.ctx, spec, self.quad_vbo)
            for spec in sorted(EFFECTS, key=lambda e: e.order)
        ]

        # Ping-pong FBOs.
        self.tex_a = self.ctx.texture((width, height), components=4)
        self.tex_b = self.ctx.texture((width, height), components=4)
        for t in (self.tex_a, self.tex_b):
            t.repeat_x = False
            t.repeat_y = False
            t.filter = (moderngl.LINEAR, moderngl.LINEAR)
        self.fbo_a = self.ctx.framebuffer(color_attachments=[self.tex_a])
        self.fbo_b = self.ctx.framebuffer(color_attachments=[self.tex_b])

        # Source texture is sized to fit arbitrary clip dimensions — it's resized
        # lazily per-upload when clip dimensions change.
        self.src_tex: moderngl.Texture | None = None
        self._src_w = 0
        self._src_h = 0

        self._clip_aspect: float = float(width) / float(height) if height > 0 else 1.0

    def apply_effect_chain(self, chain: list[EffectChainEntry]) -> None:
        if not chain:
            for e in self.effects:
                e.enabled = True
                for u in e.spec.uniforms:
                    e.base_params[u.param] = u.default
            return
        enabled_set = {c.name for c in chain if c.enabled}
        for e in self.effects:
            e.enabled = e.spec.name in enabled_set
            entry = next((c for c in chain if c.name == e.spec.name), None)
            if entry:
                for u in e.spec.uniforms:
                    e.base_params[u.param] = entry.base_params.get(u.param, u.default)

    def set_clip_aspect(self, clip_width: int, clip_height: int) -> None:
        """Record the active clip's aspect so source_fit crops correctly."""
        if clip_width > 0 and clip_height > 0:
            self._clip_aspect = float(clip_width) / float(clip_height)

    def upload_frame(self, rgb: np.ndarray) -> None:
        """Upload an (H, W, 3) uint8 frame at its NATIVE clip resolution.

        We do NOT resize the frame to the output resolution here; the
        source_fit prelude handles aspect-correct center-crop at sample time.
        We do flip rows so the texture layout matches the browser's
        UNPACK_FLIP_Y_WEBGL convention.
        """
        if rgb.ndim != 3 or rgb.shape[2] != 3:
            raise ValueError(f"expected HxWx3 uint8, got {rgb.shape}")
        h, w, _ = rgb.shape

        # Resize the source texture if clip dims changed (happens on cut boundaries).
        if self.src_tex is None or self._src_w != w or self._src_h != h:
            if self.src_tex is not None:
                self.src_tex.release()
            self.src_tex = self.ctx.texture((w, h), components=4)
            self.src_tex.repeat_x = False
            self.src_tex.repeat_y = False
            self.src_tex.filter = (moderngl.LINEAR, moderngl.LINEAR)
            self._src_w = w
            self._src_h = h

        rgba = np.dstack([rgb, np.full((h, w), 255, dtype=np.uint8)])
        # Flip rows so texel y=0 holds the visual bottom of the image — matches
        # the browser's UNPACK_FLIP_Y_WEBGL upload. Both pipelines then render
        # with identical UV conventions.
        rgba = np.ascontiguousarray(rgba[::-1])
        self.src_tex.write(rgba.tobytes())

    def render_frame(
        self,
        time: float,
        baked: BakedModulation | None,
    ) -> np.ndarray:
        """Run source_fit + user effect chain and return an (H, W, 3) uint8 ndarray."""
        ctx = self.ctx
        if self.src_tex is None:
            return np.zeros((self.height, self.width, 3), dtype=np.uint8)

        def param_value(effect: _LoadedEffect, uname: str, default: float, umin: float, umax: float) -> float:
            if baked is not None:
                target = f"{effect.spec.name}.{uname}"
                arr = baked.targets.get(target)
                if arr is not None and arr.size > 0:
                    idx = int(round(time * baked.rate_hz))
                    idx = max(0, min(arr.size - 1, idx))
                    return float(max(umin, min(umax, float(arr[idx]))))
            return float(max(umin, min(umax, effect.base_params.get(uname, default))))

        output_aspect = float(self.width) / float(self.height)

        # ---- Prelude: source_fit into fbo_a ----
        self.fbo_a.use()
        ctx.viewport = (0, 0, self.width, self.height)
        ctx.clear(0, 0, 0, 1)
        self.src_tex.use(location=0)
        self.prelude.set_uniform("uSrc", 0)
        self.prelude.set_uniform("uTime", float(time))
        self.prelude.set_uniform("uClipAspect", float(self._clip_aspect))
        self.prelude.set_uniform("uOutputAspect", float(output_aspect))
        self.prelude.vao.render(moderngl.TRIANGLE_STRIP)

        # ---- User effects: start reading from tex_a, ping-pong from there ----
        active = [e for e in self.effects if e.enabled]

        if not active:
            # Readback from fbo_a's texture.
            data = self.tex_a.read()
            arr = np.frombuffer(data, dtype=np.uint8).reshape(self.height, self.width, 4)
            arr = np.flipud(arr)
            return arr[:, :, :3].copy()

        read_tex = self.tex_a
        write_is_b = True  # next write goes to tex_b
        for effect in active:
            fbo = self.fbo_b if write_is_b else self.fbo_a
            fbo.use()
            ctx.viewport = (0, 0, self.width, self.height)
            ctx.clear(0, 0, 0, 1)

            read_tex.use(location=0)
            effect.set_uniform("uSrc", 0)
            effect.set_uniform("uTime", float(time))

            if effect.spec.needs_prev_frame:
                prev = self.tex_a if write_is_b else self.tex_b
                prev.use(location=1)
                effect.set_uniform("uPrev", 1)

            for u in effect.spec.uniforms:
                effect.set_uniform(
                    u.name, param_value(effect, u.param, u.default, u.min, u.max)
                )

            effect.vao.render(moderngl.TRIANGLE_STRIP)

            read_tex = self.tex_b if write_is_b else self.tex_a
            write_is_b = not write_is_b

        data = read_tex.read()
        arr = np.frombuffer(data, dtype=np.uint8).reshape(self.height, self.width, 4)
        # Undo the upload flip so callers get image-top-first (standard numpy layout).
        arr = np.flipud(arr)
        return arr[:, :, :3].copy()

    def release(self) -> None:
        self.prelude.release()
        for e in self.effects:
            e.release()
        self.fbo_a.release()
        self.fbo_b.release()
        self.tex_a.release()
        self.tex_b.release()
        if self.src_tex is not None:
            self.src_tex.release()
            self.src_tex = None
        self.quad_vbo.release()
        self.ctx.release()
