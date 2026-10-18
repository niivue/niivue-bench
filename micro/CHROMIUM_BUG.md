# DRAFT — Chromium bug report

**Component:** Blink>WebGPU (cc: Internals>GPU>Metal)
**Type:** Bug (performance)

## Title

WebGPU (Dawn/Metal) GPU work runs ~2x slower whenever the page has a requestAnimationFrame loop or pointer input; WebGL2 unaffected

## Environment

- Chrome 155.0.8059.40 (also seen on Chrome 153.0.8010.54)
- macOS 26.7.1 (also seen on 26.6.2)
- Apple M5 Max (also seen on Apple M4 Pro)
- AC power
- Launch flags: `--enable-unsafe-webgpu --enable-dawn-features=allow_unsafe_apis --disable-gpu-vsync --disable-frame-rate-limit`
  (`allow_unsafe_apis` is for full-precision timestamp queries only)

## Summary

A WebGPU render pass's GPU time (timestamp query) more than doubles when either of these is true:

- the page runs an unrelated, empty `requestAnimationFrame` loop;
- the user moves the pointer anywhere over the page (hover, drag, wheel).

The identical workload on WebGL2, in the same browser and on the same page, is unaffected.

The slowdown is a constant ~+2 ms rather than proportional to the work. It goes away when the GPU is kept busy
with extra passes. This looks like the GPU dropping to a lower clock/power state: something on the Dawn/Metal path
lets the GPU idle-ramp down under these conditions, and the ANGLE/Metal path does not.

## Reduced test case

Two attached files, `index.html` and `micro.js`, with no dependencies (serve over http).

- The page ray-marches a 256³ RGBA8 3D texture into an 1800x1400 canvas: one full-screen triangle, one render pass.
- It is the same shader in WGSL and GLSL.
- Each frame does `requestAnimationFrame` → draw → submit → await `onSubmittedWorkDone`.
- GPU time comes from `timestampWrites` on the pass (WebGPU) and `EXT_disjoint_timer_query_webgl2` (WebGL2).
- Output is JSON in the page: `ms` is the wall time from draw to GPU done, `gpuMs` is the median GPU time per pass.

URL parameters:

- `api=webgpu|webgl2`
- `spin=1` starts an extra `requestAnimationFrame(f => requestAnimationFrame(f))` loop that does nothing
- `w`, `h`, `frames`, `warmup`

## Steps to reproduce

1. Serve the two files (for example `npx vite` or `python3 -m http.server`).
2. Launch Chrome with the flags above.
3. Open `index.html?api=webgpu&w=1800&h=1400&warmup=60&frames=800` and keep the mouse still. Note `gpuMs`.
4. Open the same URL with `&spin=1` added. Note `gpuMs`.
5. Open the URL from step 3 and keep moving the mouse over the page while it runs. Note `gpuMs`.
6. Repeat steps 3-5 with `api=webgl2`.

## Results

Median over 800 frames, two runs each.

| condition | WebGPU gpuMs | WebGPU ms | WebGL2 gpuMs | WebGL2 ms |
|---|---|---|---|---|
| idle | 1.45 / 1.59 | 2.2 / 2.3 | 0.88 / 0.91 | 1.2 / 1.2 |
| idle + empty rAF loop (`spin=1`) | **3.41 / 3.41** | **5.0 / 5.1** | 0.91 / 0.90 | 1.2 / 1.2 |
| pointer hover | **2.23 / 2.00** | **3.1 / 3.0** | 0.92 / 0.90 | 1.2 / 1.2 |

- On the M4 Pro / Chrome 153, hover took WebGPU from 1.7-1.9 to 4.0-5.1 GPU ms; wheel and drag were similar.
  It also happened with the pointer outside the canvas.
- With 3 untimed identical passes submitted before the timed one, idle and hover measure the same (6.3 vs 6.6 ms).
  The penalty is not extra work.
- With vsync on (default flags), both APIs measure ~3.4-3.9 GPU ms in every condition (WebGPU 3.37 / 3.37 / 3.36,
  WebGL2 3.86 / 3.85 / 3.85): the GPU clocks down between vsync-paced frames on both paths. So the WebGPU-only
  difference is visible only when frames are submitted back-to-back.

## Expected

WebGPU GPU time for a fixed workload does not depend on an unrelated rAF loop or on pointer input, as with WebGL2
in the same browser.

## Actual

WebGPU GPU time increases 1.4-2.3x under either condition. WebGL2 does not change.

## Notes

- Not reproduced in Safari 26.6, on either WebGPU or WebGL2. Safari can't disable vsync, so its numbers are
  frame-period bound.
- Firefox 154 WebGL2 shows no penalty. Firefox WebGPU could not be timed.
- These made no difference:
  - `alphaMode: 'opaque'`;
  - removing `COPY_DST` from the canvas usage;
  - rendering offscreen (no canvas texture; the penalty was larger);
  - `--force-high-performance-gpu`;
  - `--enable-webgpu-developer-features`.
- Impact: frame-time benchmarks of WebGPU apps are unstable. Any harness with an rAF-polling loop (for example
  Playwright's default `waitForFunction`) reads WebGPU 2-4x slow. Under vsync the difference disappears, so the
  user-visible impact is limited to uncapped or near-budget rendering.
- Found while benchmarking NiiVue (WebGPU/WebGL2 medical image viewer); the reduced case contains no NiiVue code.
