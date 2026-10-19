# niivue-bench

Like-for-like frame-time benchmark: NiiVue 0.6x (`v06.html`) vs 1.0 (`v1.html`).
Same T1 + CAT-lite tissue maps as mono `examples/vox.tissues.html`, same 900x700 CSS canvas, same scenarios. `public/volumes` is a symlink to mono `packages/dev-images/images/volumes` (Git LFS — run `git lfs pull` there if the files are pointers).

    bun install && bun run dev    # http://localhost:5173, links to /v06.html and /v1.html

## URL params (page reloads on change; the URL reproduces the run)

| param | values | meaning |
|---|---|---|
| `dpr` | `0` (default, native `devicePixelRatio`), `1`, `1.5`, `2` | backing-store scale |
| `aa` | `1` default, `0` | anti-aliasing |
| `backend` | `webgpu` (1.0 default), `webgl2` | 1.0 only; 0.6x is always WebGL2 |
| `rate` | `1` (default), `2` | 1.0 ray samples per voxel; `1` matches 0.6x, `2` is the 1.0 library default |
| `shade` | `0` (default), `0.4`, `1` | volume render illumination |
| `mod` | `1` default, `0` | overlays self-modulate their own alpha |
| `frames` | default `60` | frames per rep |
| `reps` | default `3` | reps per measurement (median of reps reported) |
| `auto` | `1` | runs the full suite on load |

Layout, overlay count, and animation (scroll/rotate) are chosen from the page UI and are not part of the URL — the "Run suite" button cycles a fixed set of scenarios (`bench.js`'s `SUITE`).

## Compare page

`index.html` (`/`) pivots every stored run (`localStorage.nvbench`) into a scenario x config grid, `ms` per cell. "Copy TSV" for spreadsheets; "Clear" wipes storage. Results persist across reloads and versions, so old runs accumulate — clear before a clean comparison sweep.

## Standalone pages (no NiiVue)

Plain WebGL2 + WebGPU pages with inline shaders, for reproducing browser issues without the library. Open them from `bun run dev` (any static server works; WebGPU needs `localhost` or HTTPS).

- `micro/` - a NiiVue-free volume ray-march timed in both APIs. Params: `w`, `h`, `frames`, `warmup`, `aa`, `depth`, `rate`, `loop`, `present`, `api`, `pre`, `usage` (see the top of `micro/micro.js`).
- `msaa/` - does 4x MSAA shade per pixel or per sample? Times an ALU-heavy full-screen draw with MSAA off and 4x, prints the ratio (about 1x expected, 4x means per-sample shading). Params: `size`, `iters`, `frames`. Safari's WebGPU shows 4x; Chrome, Firefox and every WebGL2 show about 1x (see `CLAUDE.md`).

## Version switching

    bun add nv1@npm:@niivue/niivue@1.0.0-rc.14
    bun add nv06@npm:@niivue/niivue@0.62.1

`bun run dev` uses `vite --force` so the new version is re-bundled.

## Local mono build

    bunx nx build niivue   # in the mono checkout
    NV1_DIST=/path/to/mono/packages/niivue/dist/niivue.js bun run dev

The page reports version `local <dist mtime>` when `NV1_DIST` is set (see `vite.config.js`), so different builds stay separate on the compare page.

## Timing method

rAF start -> GPU idle (WebGPU: `onSubmittedWorkDone()`; WebGL2: a 1x1 `readPixels`, which blocks until the driver drains the queue) — no vsync floor. `cpu` = time until the frame is committed (before the GPU-idle wait). 0.6x draws synchronously inside `step()`; 1.0 only schedules a render and draws in its own later rAF callback, but that still lands before our callback's GPU sync in the same frame, so nothing is missed or double-counted (see `frame()` in `bench.js`).

## Caveats

- Frame times under ~2.5ms are dominated by Apple GPU power-state noise (non-monotonic vs. pixel count) — don't compare below that floor.
- State (loaded volumes, scene) carries over between scenarios within a session; for isolated numbers, reload between runs.
- For scripted/automated Chrome runs, pass `--disable-gpu-vsync --disable-frame-rate-limit`.
- The `cpu` column is `n/a` for 0.6x: its `drawScene` calls `gl.finish()`, so it has no CPU-only time.
- Warm-up runs at least 1.5 s so background shader-variant compiles settle before timing; each rep restarts from the same pose.
- AA and DPR must match between the two versions being compared, or differences won't isolate to renderer changes — use the URL params to pin both.

## Tools (`tools/`, run with `bun tools/<name>.mjs`, need `bun run dev` on 5173 and Google Chrome)

- `drive.mjs '<page?query>' [0]` - run a page's suite headless (or headed with `0`) and print its table.
- `gputime.mjs <layout> <ov>` - GPU-only frame time via `timestamp-query` (WebGPU) and `EXT_disjoint_timer_query_webgl2`; env `HEADED=1`, `BACKENDS`, `DPR`, `RATE`, `N`, `EVAL=<js before the loop>`, `DOMTICK=1` (mutate DOM every frame), `ALPHA=opaque`.
- `gputime3.mjs <layout> <ov>` - the bench's own `measure()` under GPU timers with real input: `MODE=measure|busy|click|jsclick|hover|wheel|drag|movehover|auto` (`AUTO=1` with `auto`).
- `count.mjs` - mean/max ray-march samples per pixel, read back from a frame that encodes the loop counters as colour.
- `patch.mjs` - runtime WGSL/GLSL patch harness: `EXPS=<names>` picks variants from its table (strip loop parts, fixed sample counts, override flags); `BASE`, `DPR`, `OV`, `CHROME_ARGS`.
- `webdriver-micro.mjs <api> <0|1>` (`BROWSER=safari|firefox`, `PORT`) - the same micro run driven through system Safari (`safaridriver -p 4444`) or Firefox (`geckodriver -p 4445`); `safari-micro.mjs` is a Safari shortcut.
- `micro-input.mjs <webgpu|webgl2> <0|1|off|half> [&extra]` - the standalone `micro/` ray-march with pointer movement over the canvas / off-canvas / for the first 2.5 s.

Findings from these tools are in `CLAUDE.md`.
