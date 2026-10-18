# CLAUDE.md — niivue-bench handoff

## Purpose

Investigate a user report that NiiVue 1.0 (rc.13) is slower than 0.62, especially with overlays.
This repo is a like-for-like frame-time bench: `v06.html` (0.62.1) vs `v1.html` (1.0), shared
harness `bench.js`, shared 900x700 CSS canvas, shared T1 + tissue-map scenes. See `README.md` for
day-to-day usage (run, URL params, compare page, version switching, local build, timing method).
This file is investigation state/history, not user docs.

## How to use

- `bun run dev`, open `/v06.html` and `/v1.html`, "Run suite", then `/` to compare.
- To test a local mono build: `bunx nx build niivue` in mono, then
  `NV1_DIST=/path/to/dist/niivue.js bun run dev` (page reports version `local <dist mtime>`).
- Pin `dpr`/`aa` identically across the two pages being compared via URL params, or differences
  won't isolate to renderer changes.
- Chrome automation: `--disable-gpu-vsync --disable-frame-rate-limit`.
- Reload between scenarios if you need isolated numbers — state (loaded volumes, scene) persists
  across scenario switches within a session.
- Frame times under ~2.5ms are Apple GPU power-state noise (non-monotonic vs. pixel count) — don't
  trust comparisons below that floor.

## Findings (Apple M4 Pro, Chrome, 1800x1400 canvas = 900x700 CSS x2 DPR)

- 1.0 WebGPU 3D tile was ~2x slower per pixel than 1.0 WebGL2. Present already in rc.3 — not a
  late regression. rc.1 doesn't load in the bench (font init failure), so it couldn't be checked.
- AA and DPR do not explain the gap at equal pixel counts. Found along the way: the 1.0
  constructor's `devicePixelRatio` option was silently ignored (fixed on
  `fix/device-pixel-ratio-option`); the bench works around it by calling the `devicePixelRatio` setter after
  `attachToCanvas`.
- **Root cause of the rc.13-vs-0.62 gap**: draw-wide uniforms (inactive clip planes, cutaway, MIP,
  cubic interpolation, gradient/lighting, layer presence) left as runtime branches in the ray-march
  shader block dead-code elimination. Inactive clip planes alone cost ~20%.
  - Fix: compile-time shader specialization per draw — WGSL `override` constants + GLSL `#define`,
    with a generic fallback path (merged as #192). Key new file: `view/NVRenderVariant.ts`.
  - **WebGPU exception**: draws with an overlay/PAQD/drawing layer stay on the generic
    (unspecialized) path even with this fix — specializing them measured up to 40% *slower* on
    Metal (Tint/Dawn compiler heuristic quirk). **Superseded 2026-10-14:** re-measured headed, specializing
    them is 7-15% faster with identical output, and the exception is removed on the local branch (see the end).
  - Also added: a `pow()` step-correction fast path for the common exponents 1 and 0.5 (~15%).
- Results, WebGL2, 1800x1400, ms/frame (0.62 / rc.13 / all fixes applied):
  - 3D tile: 2.7 / 4.2 / 2.9
  - 3D + 1 overlay: 5.7 / 6.7 / 4.5
  - 4-pane (A+C+S+R): 1.5 / 2.3 / 2.0
  - 3D + 3 overlays: 4.5 / 5.6 / 4.1
  - WebGPU 3D tile: 9.6 -> 6.5
- Final numbers (2026-09-17, AC power, rate 1 = 0.62's ray density, 1800x1400, two passes agreed):

  | scenario | 0.62 | rc.13 GL | fixed GL | rc.13 GPU | fixed GPU |
  |---|---|---|---|---|---|
  | 3D tile | 1.7 | 2.4 | 1.9 | 8.3 | 6.6 |
  | 3D + 1 overlay | 3.9 | 4.5 | 3.7 | 9.5 | 9.9 |
  | 4-pane scroll | 1.4 | 1.8 | 1.6 | 6.2 | 5.7 |
  | 4-pane + 1 overlay | 2.4 | 2.9 | 2.5 | 8.6 | 9.3 |
  | 3D + 3 overlays | 3.9 | 4.5 | 3.7 | 9.5 | 9.6 |

  origin/main alone measured the same as rc.13. The earlier table above used 1.0's default rate 2.
  A battery-powered run was bimodal (same build 10.3 vs 14.3 ms) and was discarded: benchmark on AC only.
- Splitting `NEEDS_GRADIENT` into three finer flags measured only ~5% for the lighting-only case —
  not worth the added variant-key complexity; not done.
- Remaining WebGPU-vs-WebGL2 gap after all fixes is compiler-level (Tint/Dawn vs. ANGLE), not
  something fixable from the NiiVue side.
- Algorithmic opportunity, not yet pursued: the overlay pass marches the full ray depth regardless
  of background-pass early termination — could skip past where the background already terminated.

## WebGPU vs WebGL2: what the gap actually is (2026-09-17, second pass)

The PR #192 sentence "remaining gap is compiler-level" was wrong. Evidence, all on the shader-PR build:
- Ray-march sample counts are identical on both backends (7.6 fine + 26 fast per pixel, 51M total;
  `tools/count.mjs`). Per-sample cost in a break-free fixed loop is similar (WebGPU ~1.6x GL at most).
  Dawn's robustness clamps, demote-to-helper, texture usage flags, MSAA/depth stores, loop shape,
  fast-math (on by default in both Dawn and ANGLE) all measured irrelevant.
- GPU timestamp queries (`tools/gputime.mjs`, headed Chrome, 5/5 sessions): WebGPU render pass
  0.93 ms vs WebGL2 frame 1.41 ms (3D tile, 1800x1400); 4-pane+1 overlay 1.59 vs 1.76;
  3D+1 overlay 3.33 vs 3.18. At rest WebGPU is at least as fast as WebGL2 in NiiVue.
- The wall-clock gap is a Chrome/Dawn-on-macOS effect: while the page receives pointer input
  (hover, drag, wheel; anywhere in the window, not just the canvas) WebGPU passes run 2.5-3.5x
  slower (GPU 0.93 -> 3.4-5.1 ms, CPU 0.1 -> 0.6-1.3 ms) and WebGL2 is unaffected. Also ~60 slow
  frames after any ~0.5 s idle pause. Recovers ~100-200 frames after input stops. A standalone
  WebGPU page (`micro/`, `tools/micro-input.mjs`) shows the same: 1.7 ms idle, 4.0 ms hover, 6.4 ms
  hover while rendering offscreen (no swapchain). alphaMode opaque and dropping COPY_DST on the
  canvas do not help. This reproduces the user's "jerky scrolling" (wheel = input) and is outside
  NiiVue; worth a Chromium bug with `micro/` as the repro (Chrome 153, macOS 26, M4 Pro).
- Cross-browser (same micro page, tools/webdriver-micro.mjs): Safari 26.6 shows no input penalty
  (WebGPU 13 ms idle / 10 ms hover, WebGL2 10 / 8; Safari cannot disable vsync so absolute numbers
  are frame-period bound). Firefox 154 WebGL2 4 / 4 ms, no penalty; Firefox WebGPU is unmeasurable
  this way (onSubmittedWorkDone/mapAsync resolve on a ~100 ms cadence at any size, even offscreen,
  and its timestamp query returns negative values). So the input slowdown is Chrome-specific.
- Separate, smaller effect: a DOM text mutation every frame (e.g. a location footer) costs WebGPU
  ~2 ms wall per frame at rest; `alphaMode: 'opaque'` on the canvas removes that one. Not applied
  to NiiVue (transparent canvases need premultiplied); could be an option.
  **Retracted 2026-10-14:** that test (`DOMTICK=1`) mutates the DOM from its own free-running rAF loop, which
  slows WebGPU by itself. Re-run: opaque helped in one round (6.6 -> 3.8) and hurt in the next (4.0 -> 5.5).
  With a realistic readout there is no effect (see the end).
- Headless Chrome adds a further per-session multimodal GPU state (same commands 0.95..5.6 ms);
  every earlier bench table was headless, and the bench's own `Run` (a real click) lands in the
  input-slow state. Use `HEADED=1` and `tools/gputime.mjs` for WebGPU numbers.

## Measurement pitfalls (see also README "Caveats")

- Fresh page per scenario — state carries over between scenarios within a session.
- Sub-2.5ms frames are GPU power-state noise, not signal.
- Runtime WGSL/GLSL patching (wrap `GPUDevice.createShaderModule` / `WebGL2RenderingContext.shaderSource`)
  is useful to isolate shader-only cost from the rest of the frame.
- 1.0 draws inside its own rAF callback rather than synchronously; the harness's `frame()` in
  `bench.js` accounts for this (registers its GPU-sync callback before stepping, so nothing is
  missed or double-counted) — read it before changing timing logic.

## Pull requests (all merged into niivue/mono main by 2026-09-18, main = cfb4f9c)

- #187 opacity fade + vox.tissues.html demo (user's), #189 ipyniivue regen (user's).
- #191 `devicePixelRatio` constructor option reaches the views; setter keeps `opts` in sync.
- #192 compile-time shader specialization (`view/NVRenderVariant.ts`), background WebGL2 variant
  compile, `pow()` fast path. Its description carries the corrected WebGPU-vs-WebGL2 explanation.
- #193 `isViewModeHotKeyEnabled` (V cycles views, off by default), hotkeys scoped to the viewer
  under the pointer, shadow-root-aware focus guard, WebGPU toggle in vox.tissues.html.
- Local state: `~/src/mono` is on `main`; the worktrees mono-shader, mono-dpr and mono-combined and
  their branches were removed. To bench the current code: `bunx nx build niivue` in `~/src/mono`,
  then `NV1_DIST=/Users/chris/src/mono/packages/niivue/dist/niivue.js bun run dev` here.

## Audit 2026-09-17 (decisions)

- Fixed: WebGL2 synchronous variant compile, shader-object leak, clip-key NaN/float32 mismatch,
  hotkey focus inside shadow roots, demo backend toggle races, stale ipyniivue bindings.
- Bench fixed: 1.0 ran 2 ray samples per voxel vs 0.62's 1 (new `rate` param, default 1; numbers
  before this date used 2 for 1.0), 0.62 skipped its gradient on the first shaded load, warm-up
  now time-based (1.5 s) for background variant compiles, controls disabled during runs, median
  averages the middle pair, each rep restarts from the same pose, 0.62 `cpu` shown as n/a (its
  drawScene calls gl.finish), compare page keys include rate and browser, local builds labelled
  by dist mtime.
- User decision: hotkeys act only on the viewer under the pointer (done in #193).
- Still open for the user: the opacity fix writes first-hit depth for a faded background (a mesh
  inside a translucent head is hidden except via X-ray).
- Declined: splitting NEEDS_GRADIENT (~5%); shared DPR helper across six call sites (scope creep);
  trimming comment blocks in the user's opacity commit (churn).

## Window/level cost (2026-09-18)

- A window (`calMin`/`calMax`) change on the 384x320x89 int16 torso CT costs
  ~1.3 ms (WebGL2) and ~1.8-2.5 ms (WebGPU) until the GPU has finished; `await
  setVolume` itself is 0.1-0.8 ms. An earlier "18 ms" figure was wrong — it
  wrongly included two display-paced animation frames.
- The scalar source stays on the GPU; only the colorize pass re-runs. The
  controller already coalesces in-flight updates.
- Shader-side windowing was evaluated and rejected: est. 1000-1500 LOC, with
  parity and fast-pass risks.
- Remaining small opportunities (not pursued):
  - Early-out in `setVolume` when nothing changed.
  - Colormap change re-uploads the whole scalar volume.
  - >=2 overlays re-upload every overlay per `setVolume`.
  - Chunked volumes key their chunk cache on `calMin`/`calMax`, so a window
    change re-streams everything.

## PR review: niivue/mono#184 (2026-09-18)

Reviewed. Its `optimizeDeps` exclude for `@niivue/dcm2niix` is already present
in `apps/demo-ext-dcm2niix`. Its demos import an extension from core
`examples/`, creating a dependency cycle that the PR hides by removing `^build`.

Eight small library changes would remove the worker demo's DOM shims
(`examples/vox.worker.html`/`.js`):
1. Duck-typed canvas check instead of `instanceof HTMLCanvasElement` (6 places).
2. `globalThis.devicePixelRatio` helper for 8 sites.
3. Guard the `window` keydown listener.
4. Guard `ResizeObserver`.
5. Load font/matcap/thumbnail textures via `fetch` + `createImageBitmap`
   instead of `new Image()`/`.decode()` — this also unblocks WebGPU in workers.
6. Guard `canvas.style`.
7. Optional-call pointer capture.
8. One CSS-size accessor replacing 9 `getBoundingClientRect` calls.

Branch state: work is on branch `docs/ct-demo` in `~/src/mono`, pushed 2026-09-18 as branch `CT` on niivue/mono (7 commits, audited, all checks green, no PR opened yet).

## Open next steps

1. PRs are merged. Once the next rc is published, switch the bench with
   `bun add nv1@npm:@niivue/niivue@<new rc>` and re-baseline (headed, `tools/gputime.mjs`).
2. Possible further shader specializations to evaluate (measure before committing, per the WebGPU
   overlay lesson above):
   - `invGamma == 1` (identity gamma) fast path
   - `layerGradMode` as a compile-time flag
   - `sampleRate` as an override constant
   - slice shader flags (2D path currently unspecialized)
   - chunked-plan variants
3. Overlay-pass early termination against the background pass's already-terminated depth
   (algorithmic, not just specialization) — not yet prototyped.
4. WebGPU-vs-WebGL2 compiler gap (Tint/Dawn vs. ANGLE) is out of NiiVue's control; not actionable
   here beyond what's already done.
5. Decide whether a faded background should still write depth (audit section).

## Re-check 2026-09-26 (rc.14 npm and mono main = rc.16+pinch; Chrome 153.0.8010.54, macOS 26.6.2, AC)

- rc.14 and main measure identically. At rest (headed, `tools/gputime.mjs`, GPU ms, 1800x1400):
  3D 0.93 WebGPU / 1.43 WebGL2; 3D+1 ov 3.3 / 3.15; 4-pane+1 ov 1.57 / 1.75; 3D+3 ov 3.3 / 3.14.
  The ~5% WebGPU overlay deficit is the deliberately unspecialized overlay path (see #192 note).
- Input penalty unchanged: WebGPU 0.93 -> 3.3 (drag), 3.45 (hover), 4.5 (wheel) GPU ms; WebGL2 flat.
  NiiVue-free `micro/` still reproduces it (1.86 -> 5.1, also with the pointer off-canvas).
- Penalty is ~+3 ms per frame, not proportional (rate=3: 3.7 -> 6.3). New `micro` param `pre=N`
  (untimed passes first): pre=3 idle 6.3 / hover 6.6, i.e. it vanishes under sustained GPU load.
  Reads as a GPU power-state/clock ramp that Chrome's WebGPU path loses during input. Apple pass
  timestamps also absorb preceding overlapping passes, so per-pass costs don't add linearly.
- Vsync on, real drag-rotate (scratch script, not kept): no missed rAFs on either backend; WebGPU
  3D+1 ov GPU 5.7 ms med / 7.3 p95 (rate 1), 6.3 / 7.5 (rate 2) against an 8.3 ms 120 Hz budget.
  Headroom is thin on this M4 Pro; slower GPUs would drop frames on WebGPU first.
- Verdict: browser (Chrome/Dawn) issue, not NiiVue. Only app-side lever is padding GPU load (wastes
  power; rejected). File a Chromium bug with `micro/` + `tools/micro-input.mjs`.
- Flags tried on `micro/` (via new `CHROME_ARGS` env in `tools/micro-input.mjs`): `--force-high-performance-gpu`,
  `--enable-webgpu-developer-features`, and both together. Hover penalty unchanged (~1.8 -> 4.2-5.3 GPU ms).

## Interaction re-check 2026-10-14 (mono main e05a2b6e = rc.22; Chrome 155.0.8059.40, macOS 26.7.1, Apple M5 Max, BATTERY)

This and later sections are on an Apple M5 Max, not the M4 Pro of the earlier sections.

All numbers on battery (user OK'd); within-session interleaved comparisons only. Main is built in
the worktree `~/Dev/mono-main` (origin/main e05a2b6e; fix branch below checked out): `NV1_DIST=/Users/chrisdrake/Dev/mono-main/packages/niivue/dist/niivue.js bun run dev`.
`public/volumes` must be a symlink to mono `packages/dev-images/images/volumes` (not in git).

- rc.14 (npm) and main measure identically at rest (`gputime.mjs`, both on one session):
  3D 0.42 GL / 0.35 GPU; 3D+1 ov 0.86 / 0.95 GPU ms.
- **Default path is clean.** `tools/vsync-input.mjs` (vsync ON, real drag/wheel/hover driving NiiVue's
  own handlers, 3D+1 ov and 4-pane+1 ov, both backends, 2 rounds): 0 missed frames at 120 Hz, never
  more than 1 NiiVue render per animation frame. Hover renders nothing. Chrome delivers <=1 pointermove
  per frame even at 1000 Hz input.
- **Vsync-off "input penalties" are bench-mode artifacts.** NiiVue-free `micro/`: WebGL2 wheel 0.89 ->
  2.6 GPU ms, WebGPU hover 1.6 -> 2.0, wheel -> 3.4; penalty vanishes under sustained load (`pre=3`, now
  also on WebGL2) and with vsync on (`VSYNC=1`: all modes ~3.3-3.7 GPU ms on both APIs, GPU downclocks
  between frames). Blocking the events before NiiVue (`-blocked` modes in `tools/input.mjs`) did not
  change the cost: it is browser/GPU power state, not NiiVue work.
- **A free-running empty rAF loop slows WebGPU 2-4.5x with vsync off** (NiiVue 3D+1 ov 0.94 -> 4.5 GPU ms;
  `micro/?spin=1` 1.7 -> 3.4); WebGL2 unaffected; invisible with vsync on. Harnesses must not spin a rAF
  counter: `tools/input.mjs` only does with `RAFS=1`. (Its early WebGPU rows with the counter were invalid.)
- **NiiVue defect: `NVCanvasViewportController` renders twice per frame** during pan and wheel zoom
  (both backends, 2D and 3D): `apply -> nv.setViewport -> view.resize() -> render()` synchronously
  (`NVControlBase.ts:4737`, `gl/NVViewGL.ts:1685`, `wgpu/NVViewGPU.ts:2305`), plus the `drawScene` rAF
  render. Measured 2.0 renders/frame vs 1.0 for the same pan without the controller. Bench: `v1.html?viewport=1`
  (local builds; vite alias `nv1/viewport`), mode `pan` = right-drag. Not yet linked to the user's report.
- Unverified from code trace: chunk-pump / busy-retry rAF loops can stack (`gl/render.ts:1599`) during
  OME-Zarr streaming; windowing drag runs a full `_updateGLChanged` per pointermove (non-default mode).
- Heavy scene for the controller (render, 3 ov, `shade=1`, `dpr=4`, rate 2; `QS='&viewport=1&shade=1&dpr=4'`),
  missed 120 Hz frames out of ~440 with the controller: GL pan 35-36, GL wheel 45-46, GPU pan 40-44, GPU wheel
  71-72. The same drag without the controller: 0.
- **Fix (local branch `perf/viewport-no-sync-render` in `~/Dev/mono-main`, uncommitted, not pushed, no PR;
  `NVControlBase.ts` only, +30/-10).** `setViewport` keeps its synchronous `view.resize()` render (apps rely on
  it, see the sheet below). The rAF scheduled by `drawScene` is split into `_requestFrame()` plus a
  `_renderRequested` flag: after the synchronous render, a render already queued is cancelled (it would show the
  same state), unless a drawing flush is pending. The frame still runs `_flushDrawing`/`_sync`. tsc clean,
  1722 tests pass.
  - Heavy scene, missed frames after the fix: GL pan 0/479, GPU pan 0/480 (1.0 renders/frame); GL wheel 8/474,
    GPU wheel 27/453 (1.3 renders/frame).
  - Wheel stays above 1 render/frame because the bench lets NiiVue's own wheel handler zoom the 3D scene as
    well. Its rAF render runs a frame before the controller's tick, so it cannot be merged. This is
    bench wiring; the sheet blocks NiiVue's wheel.
  - Pan double-handling is similar: NiiVue's default right-drag is `DRAG_MODE.contrast`, so a controller pan
    also drives the contrast box. The fix merges those two renders into the synchronous one.
  - `applyToRenderMs` now reads ~8 ms on pan. That's a metric artifact: the render happens inside `apply`,
    before `onChange` records the time.
- First attempt (rejected, saved as scratch `deferred-render-fix.patch`): skip `resize()`'s synchronous render
  and rely on `drawScene`. It broke the IIIF sheet viewer, which clears the shared WebGL2 canvas in `apply`.
  During inertia `apply` runs inside the controller's rAF, so the deferred render landed a frame later:
  672/825 blank frames vs 21/824 on main.
- Sheet check (`tools/sheet-zoom.mjs`; sheet on :8087, stub `/api` on :8080 serving `chris_t1` from
  dev-images). It counts committed WebGL2 frames whose last op was the sheet's `clearCanvas()`.
  - With the fix: pan + inertia 21/824 (same as main), minimap wheel 0.
  - WebGPU mid-zoom and mid-pan screenshots show all 9 tiles.
  - The 21 occur on main too. They look like clears where `setViewport` early-returns on an unchanged
    (edge-clamped) viewport. They are transient: the sheet is fully drawn after the pan settles.
  - The sheet blocks wheel on the main canvas (zoom is via the minimap only, despite its help text).
  - Its right-drag pan also triggers NiiVue's contrast drag in the cell under the pointer.
- **WebGPU texture churn fixed (same local branch, `wgpu/NVViewGPU.ts`, uncommitted; scratch
  `texture-reuse.patch`).** Before, `_updateMultisampleTarget` recreated the bounds color, MSAA and depth
  textures whenever the bounds size changed, i.e. on every zoom frame (3 `createTexture`/frame). Sub-canvas
  targets are now reused while they cover the bounds and are no more than 2x slack larger. They grow with
  headroom `min(n/4, 512)` px per axis, clamped to `maxTextureDimension2D`. `copyBoundsRect` already copies
  only the top-left bw x bh. Full-canvas and bench-offscreen targets stay exact: `render()` refits MSAA/depth
  to the actual color target. tsc clean, 1722 pass.
  - Heavy scene, WebGPU wheel: 27 -> 4-7 missed frames (2 rounds), 0.11 textures/frame. WebGL2 control
    unchanged at 8-10. Pan stays 0 on both.
  - Sheet on WebGPU: 0 blank frames, no validation warnings at moderate zoom. Screenshot at 5x is clean.
- **Pre-existing WebGPU bug (main too, not fixed):** past ~9x zoom the bounds exceed the 16384 px texture
  limit. `createTexture` fails, the instance renders nothing, and Dawn floods "exceeded maximum texture size"
  / "Invalid Texture" warnings. Both sheet and bench hit it. Fix idea: size the bounds target to the on-canvas
  part only (render with an offset viewport); that also cuts deep-zoom memory.

## WebGL2 vs WebGPU on AC (2026-10-14, local build = main + controller fix + texture reuse)

- At rest, `gputime.mjs` (headed, 1800x1400, rate 1), GPU ms GL / GPU: 3D 0.43 / 0.36; 3D+1 ov 0.87 / 0.97;
  4-pane+1 ov 0.50 / 0.48. All of these are below the 2.5 ms noise floor.
- Heavy (`DPR=4 RATE=2`, shading on, 3600x2800), 2 rounds agreed. GPU ms GL / GPU (wall ms GL / GPU):
  3D 2.6 / 2.2 (3.1 / 3.5); 3D+1 ov 4.9 / 5.05 (5.5 / 6.3); 4-pane+1 ov 2.3 / 2.1-2.35 (3.1 / 3.6-3.9).
  WebGPU wall is consistently ~0.5-0.8 ms higher than its GPU time. 3 overlays cost the same as 1.
- Vsync on, heavy 3D+3 ov, `vsync-input.mjs`, 2 rounds:
  - NiiVue's own drag/wheel: 0 missed frames on both backends.
  - With the controller, pan: 0-1 missed. Wheel: 7-9 missed on both backends (the bench's double-zoom
    wiring). The two backends are indistinguishable here.
- **Bench fix (`v1.html`, `viewport=1`):** NiiVue's own wheel and right-button pointer handlers are now
  filtered: `attachToCanvas`'s listeners are wrapped, because NiiVue has no switch for them. Before, every
  controller wheel step also zoomed the 3D scene, and every pan also ran a contrast drag. `lastApply` is now
  stamped inside `apply` (`applyToRenderMs` was an artifact). Heavy 3D+3 ov on AC, 2 rounds: exactly 1
  render/frame on every frame, never 2. WebGL2 pan/wheel 0 missed; WebGPU 1-2 missed (one ~17-25 ms frame).
  apply->render latency 0-0.1 ms (render is synchronous). This supersedes the "wheel 7-9 missed" and
  "1.3 renders/frame" rows above.
- 3 overlays costing the same as 1 is genuine, not a bench bug: all 3 load (checked `nv.volumes`). Overlays
  are blended into one texture before the ray march (0.62 also measured 3.9 / 3.9).
- **Controller claims its events (prototype, uncommitted in `~/Dev/mono-main`).**
  - New `NVCanvasViewportController` options:
    - `claimEvents` (default true): pointer and wheel listeners go in the capture phase, and consumed events
      (pan pointerdown/move/up/cancel, wheel) call `stopImmediatePropagation`. NiiVue's bubble listeners
      never see them, even though they were registered first.
    - `wheelZoom` (default true): false registers no wheel listener.
  - The sheet passes `wheelZoom: false`. Without it, the controller's capture-phase wheel listener would run
    before the sheet's capture blocker (registered later), and the main canvas would start zooming.
  - Tests: 6 in `NVCanvasViewportController.test.ts` (fake canvas on Bun's EventTarget); 1728 pass.
  - Bench: the listener-wrapping hack is now opt-in (`vpfilter=1`, for builds without claiming); `claim=0`
    turns claiming off.
  - Heavy scene, 3 ov, vsync on:
    - claiming: 1.0 render/frame, 0-1 missed frames, the same as the hack;
    - `claim=0`: wheel 1.3 renders/frame, 8 missed, and NiiVue zooms the 3D scene too (scale 1 -> 0.5).
  - Sheet: pan 15 blank frames (21 before); minimap wheel works; main-canvas wheel stays at 1.00x on both backends.
- **Why WebGL2 wall time is lower (AC, heavy 3600x2800, 2 rounds agreed; scratch `split.mjs`).** Per frame it
  measures JS time, the wait for the GPU, and back-to-back throughput (no per-frame sync).
  - An opaque WebGPU canvas (`alphaMode: 'opaque'`) changes nothing: 3D+1 ov wall 6.3-6.5 either way, throughput
    5.3-5.4. Compositing is not the gap; the earlier opaque win only applied with a per-frame DOM mutation.
  - Part of the gap is the timing method. WebGL2 timed with an async fence (polled, like WebGPU's
    `onSubmittedWorkDone`) instead of a blocking `readPixels` gains 0.2-0.4 ms of wall time
    (3D+1 ov 5.4 -> 5.7-5.8, 3D 3.0 -> 3.2).
  - Throughput (ms/frame): 3D 2.56 GL / 2.58-2.68 GPU (tie); 3D+1 ov 4.77-4.8 GL / 5.3-5.4 GPU (~11% slower).
  - WebGPU throughput exceeds its own GPU time by ~0.4-0.5 ms in both scenes: 3D 2.14 GPU vs 2.6 throughput,
    3D+1 ov 4.9 vs 5.35. In GL, throughput ~= GPU time. On the plain volume, WebGPU's faster GPU time hides that
    fixed cost; with an overlay there's no GPU advantage to hide it.
  - Of the fixed cost, NiiVue's JS per frame is 0.2-0.4 ms on WebGPU vs ~0.1 ms on GL. The rest is in Chrome
    (submit and presenting the canvas texture), not visible without a Chrome trace.
  - A NiiVue WebGPU frame is 1 render pass, 7 draws, 13 `writeBuffer`, so the first-pass timestamp covers all
    of its GPU work.
- **Layered WebGPU draws now specialize (local branch, `wgpu/render.ts` + `AGENTS.md`, uncommitted).**
  - The rule keeping overlay/PAQD/drawing draws on the generic shader is removed; WebGL2 already specialized them.
  - Re-measured headed on AC, Chrome 155, with a temporary switch, interleaved, 2 rounds (heavy = 3600x2800, rate 2,
    shading). Back-to-back ms/frame, generic -> specialized: 3D+1 ov 5.3 -> 4.66; 3D+3 ov 5.26 -> 4.63;
    4-pane+1 ov 2.6 -> 2.4; 3D+1 ov+clip 4.58 -> 4.3; 3D+1 ov+drawing 6.95 -> 5.96; default 3D+1 ov 1.41 -> 1.24.
  - The old +40% was measured on an M4 Pro, likely headless; this re-measurement is on an M5 Max. Headless noise is the likely
    explanation, but a different GPU generation is not ruled out. The commit (e4b23696) does not record the scenario.
  - Parity: generic vs specialized screenshots in one page differ by at most 1/255 (3D+1 ov, 3D+3 ov shaded,
    clip plane, 4-pane, drawing layer, drawing only).
  - PAQD is untested: no PAQD file in the bench.
  - Final build, back-to-back ms/frame GL / WebGPU: 3D 2.56 / 2.56-2.59; 3D+1 ov 4.77 / 4.66; 3D+3 ov 4.76 / 4.63;
    4-pane+1 ov 2.38-2.4 / 2.3; default 3D+1 ov 1.34 / 1.22.
  - WebGPU's ~0.45 ms per-frame overhead remains, but its faster GPU time now covers it in every scene.
  - tsc clean, 1728 pass.
- **`tools/drive.mjs` was inflating WebGPU (fixed).** Playwright's `waitForFunction` polls with rAF by default,
  i.e. a free-running rAF loop, which puts WebGPU in Chrome's slow state (see above). Now `polling: 1000`.
  Before the fix the headed suite read WebGPU 3D 3.6 ms / cpu 0.8 vs WebGL2 0.8; after, 1.0 / 0.1. Every earlier
  `drive.mjs` WebGPU number is suspect.
- Full suite, final local build (all four fixes), headed, AC, 2-3 rounds, bench `ms` (median synced wall per frame):

  | scenario | GL default | GPU default | GL heavy | GPU heavy |
  |---|---|---|---|---|
  | multi2d/ov0 scroll | 0.7-1.0 | 0.9 | 1.3-1.8 | 2.1 |
  | render/ov0 rotate | 0.7 | 1.0-1.8 | 3.0-3.1 | 4.2-4.8 |
  | render/ov1 rotate | 1.2 | 1.3-2.2 | 5.4 | 5.85-5.9 |
  | multi/ov0 scroll | 0.8-0.9 | 1.0 | 2.0 | 2.6-4.5 |
  | multi/ov1 scroll | 1.0-1.1 | 1.2 | 3.0 | 4.1-4.5 |
  | render/ov3 rotate | 1.2 | 1.3 | 5.4-5.45 | 5.2-5.4 |
  | multi/ov3 scroll | 1.0-1.05 | 1.2-1.4 | 2.9-3.0 | 3.0-3.3 |

  heavy = `dpr=4&rate=2&shade=1` (3600x2800). WebGL2 repeats to +-0.1 ms; WebGPU varies by up to 2x run to run, and
  in-page order effects appear (heavy multi ov0 slower than ov3). The suite's per-frame-synced wall time leaves the GPU
  idle between frames and includes WebGPU's slower sync path (~0.3-0.4 ms, see split.mjs above). Back-to-back
  throughput (`split.mjs`) is the fairer backend comparison and shows WebGPU level or ahead.
- **Why WebGPU reads slower in the suite** (scratch `suitegpu.mjs`: `bench.measure()` plus a per-frame GPU timer on
  both backends, WebGPU timestamps and GL `EXT_disjoint_timer_query`; heavy `&dpr=4&rate=2&shade=1`; fresh page per
  scenario and the whole suite in one page). Values are wall / GPU ms.

  | scenario | GL | WebGPU fresh | WebGPU suite |
  |---|---|---|---|
  | multi2d/ov0 | 1.0 / 0.47 | 1.7 / 0.67 | 2.2 / 1.04 |
  | render/ov0 | 3.0 / 2.56 | 3.3 / 2.22 | 4.1 / 2.6 |
  | render/ov1 | 5.3 / 4.91 | 5.4 / 4.36 | 5.5 / 4.38 |
  | multi/ov0 | 2.0 / 1.37 | 2.3 / 1.05 | 3.3 / 1.72 |
  | multi/ov1 | 3.0 / 2.24 | 3.2 / 1.88 | 3.3 / 1.89 |
  | render/ov3 | 5.4 / 4.92 | 5.4 / 4.37 | 5.4 / 4.34 |
  | multi/ov3 | 3.0 / 2.23 | 4.6 / 2.2 | 4.3 / 2.19 |

  GL numbers were identical fresh and suite.
  - GPU work: WebGPU is equal or 10-25% lower on every 3D and 4-pane scene. 2D slices (multi2d) cost it more GPU,
    but under 1 ms.
  - The deficit is outside the GPU work. Wall minus GPU is 0.4-0.7 ms on GL and 1.0-2.4 ms on WebGPU. It is largest
    on light scenes and varies run to run (multi/ov3 reps 3.3 vs 4.6 at the same GPU time). Heavy scenes (ov1/ov3
    render) come out level: 5.4 vs 5.3-5.4.
  - WebGPU GPU time also drifts between pages for the same scene (multi/ov0 1.05 vs 1.72; earlier runs 1.23 vs 3.23).
    GL repeats to +-0.01 ms. This is the GPU clock/power-state effect from the 2026-09-26 section.
  - Both effects are Chrome's WebGPU path (Dawn submit -> completion -> JS), not NiiVue work: NiiVue issues one pass and
    under 0.5 ms of CPU per frame on either backend. In back-to-back rendering the fixed cost mostly overlaps (see the
    throughput table above). It is still a real cost per synced frame, and it is consistent with WebGPU's 1-2 missed frames vs
    0 on GL in the heavy vsync drag.
- **Opaque WebGPU canvas: no benefit, not implemented.** `tools/vsync-input.mjs` gained `READOUT=1` (an app-style
  text readout updated on every pointermove/wheel) and `ALPHA` (forces the WebGPU canvas `alphaMode`).
  - Setup: vsync on, real drag and wheel, heavy 3D+3 ov (`QS='&shade=1&dpr=4'`), rates 2 and 4, 2 rounds each.
  - Results: every variant (GL, WebGPU premultiplied or opaque, readout on or off) missed 0-2 frames out of ~480,
    with p95 at 9.0-9.3 ms. The isolated single misses (max 25-42 ms) came from both alpha modes.
  - At this load, neither a DOM readout nor the canvas alpha mode affects frame pacing.
- **Chromium bug draft: `micro/CHROMIUM_BUG.md`** (not filed). Fresh `micro/` numbers on AC, M5 Max, vsync off, WebGPU / WebGL2
  GPU ms: idle 1.45-1.59 / 0.88-0.91; `spin=1` 3.41 / 0.90-0.91; hover 2.0-2.23 / 0.90-0.92. With vsync on, every
  condition reads 3.36-3.37 / 3.85-3.86: both APIs downclock equally, so the WebGPU-only penalty needs uncapped frames.
- **Where we left off (2026-10-14).**
  - `~/Dev/mono-main` branch `perf/viewport-no-sync-render`, 4 commits on e05a2b6e, not pushed, no PR:
    - bad71a96 controller single render;
    - 68e30461 controller event claiming;
    - 784f6024 WebGPU texture reuse;
    - fb20b2a2 layered WebGPU specialization.
  - Bench changes are committed on branch `interaction-recheck`.
  - Chromium bug: `micro/CHROMIUM_BUG.md` is a draft. Before filing, decide whether it's worth it: the slowdown is
    invisible with vsync on.
  - Untested: whether non-rAF WebGPU loops (compute, chunk streaming) hit the Chrome slowdown with vsync on.
  - Not started: the deep-zoom 16384 px texture limit bug, the sheet's help text, a PAQD test.
