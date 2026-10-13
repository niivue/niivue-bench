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
    Metal (Tint/Dawn compiler heuristic quirk). This is load-bearing and easy to "fix" by accident;
    don't specialize the overlay/PAQD/drawing passes on WebGPU without re-measuring on Metal.
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
