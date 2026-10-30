# Resonance Engine

A toroidal field of 84×56 coupled oscillators that is also an instrument. The
physics is genuine Kuramoto-style phase coupling, so the grid self-organises
into travelling waves and spirals; the music is generated from the same
dynamics, so you hear the synchronisation rather than merely watch it.

Conduct waves with the pointer, and the field composes the consequences: your
playing competes with the autonomous part for a shared polyphony budget, and
with *Self-hearing* on, every note you play biases the whole field's tempo
toward itself, so the instrument partially tunes itself.

## What you are looking at

4,704 little metronomes, each swinging at its own speed, arranged so **left is
low pitch and right is high**. Each one nudges its four neighbours, so a
disturbance you make spreads outward as a wave. **Bright means recently set in
motion** — you are watching energy, not colour and not position.

**Drag anywhere.** You paint a bright trail and hear notes; higher on screen is
higher pitch. That single gesture is the instrument. Try **Burst** (or `b`) to
set every cell going at once, then raise **Coupling** and watch the waves travel
further before dying out.

A field left alone looks like dim, sparse texture. That is correct: nothing has
been set in motion. The interesting pictures come from you, or from high coupling
organising the noise on its own.

This explanation also appears **in the app** on first visit, dismissed by the
Start button, by `Escape`, or by just starting to drag.

### Reading the numbers

- **Activity** — how many cells are still carrying energy from being conducted.
  Zero at rest. This is "what have I done lately".
- **Coupling** — how strongly neighbours listen. The dial that matters.
- **Local order** — how much nearby clumps agree. This is the number that rises
  when you increase coupling.
- **Order** — global synchrony. **Stays near zero, correctly.** Each column wants
  a different pitch, so the grid organises into travelling waves rather than one
  unison; a grid locked to a single pitch could not make a melody either.

## Accessibility

- **Touch**: 44px targets throughout, safe-area insets for notches, a scrollable
  control sheet, and drag-to-conduct works with `touch-action: none`.
- **Reduced motion** (`prefers-reduced-motion`): the decorative rising pulses and
  transitions are removed. The field itself keeps moving because the simulation
  *is* the app; **Pause** stops it completely.
- **Screen readers**: landmarks, a labelled canvas, and a throttled live region
  announcing `Order, local order, N voices` about every two seconds. The note
  readout is `aria-live="polite"`. Announcing at frame rate would queue hundreds
  of updates and be unusable, which is worse than announcing nothing.
- **Contrast**: a conducted stroke is **3.75:1** against the resting field (WCAG
  non-text target is 3:1). Four palettes ship; `mono` is luminance-only and needs
  no colour discrimination at all.

## Launch

**Open `index.html`.** It is one self-contained file — markup, CSS and the whole
engine inlined — so it works from the desktop, from `file://`, and inside a
sandboxed preview pane with an opaque origin (which is what Paseo does with a
linked HTML file). No server, nothing fetched.

```sh
xdg-open index.html       # or just drag it into a browser
python3 serve.py          # optional: same page over http://127.0.0.1:8000/
```

`serve.py` is a convenience, not a requirement. It takes its bind address from
the environment — `HOST`/`PASEO_PORT` as a Paseo daemon injects them, then
`PORT`, then loopback:8000 — and sets the MIME types that make a wrong static
server a blank page. Its address resolution and MIME map are covered by
`tests/serve.test.mjs`; the socket itself is not, because this sandbox denies
`socket()`, so **serving over HTTP end-to-end is unverified here**. The page does
not depend on it: `index.html` was verified over `file://` and in an opaque-origin
frame instead.

`index.html` is **generated**. Edit `src/` or `styles.css`, then run
`node tools/build-standalone.mjs`; a wiring test fails if the committed page has
drifted from a fresh build, so editing the generated file directly survives only
until that check next runs.

**Open `index.html`, not `src/page.template.html`.** The template is markup
waiting to be built; opened on its own its stylesheet and module are relative
paths that resolve to nothing, so it paints bare controls around a dead canvas
and — the awkward part — logs **nothing at all**, which looks like a broken app
rather than the wrong file. It is named `.template.html` so it cannot be picked
by accident, it prints a notice across the top when opened directly, and a test
fails if any source `.html` is named like a page it cannot be.

Click **Enable audio** — browsers require a user gesture before sound.

## Controls

| Input | Effect |
| --- | --- |
| Drag on the field | Push waves through it (no sound) |
| Drag with the button held | Also sound notes along the pitch axis |
| `a s d f g h j k` | Scale degrees 1–8 |
| `z x v` | Scale degrees 9–15 (row 2; see note below) |
| `Space` | Pause / run |
| `b` | Burst — reset every cell to phase zero |
| `c` | Silence — drain all energy and pending notes |
| `m` | Mutate — randomise scale, root, coupling and spread |
| `n` | Reseed phases |
| `r` | Reset everything to defaults |

Notes are two keyboard rows, each continuing an octave above the last: row 1 is
`a s d f g h j k` (degrees 1–8) and row 2 is `z x c v b n m` (degrees 9–15).
`c`, `b`, `n`, `m` double as the commands below and commands win, so those four
keys on row 2 are reserved and never sound a note.

Panel sliders: **Tempo** (musical time), **Time** (engine timestep), **Coupling**
(how strongly neighbours listen), **Noise**, **Spread** (octaves across the
canvas), **Volume**, **Space** (delay + reverb send). Selects choose scale,
root, frequency map, which axis the pointer plays, and palette.

**Coupling is the dial to explore.** It sets how strongly neighbours listen: at 0
the grid is pure noise, mid-range it organises into travelling waves and spirals.

Be clear about what "locking" means here. **The Order readout will stay near
zero**, and that is correct rather than a fault: every column is tuned to a
different pitch, and a ~24× spread of natural frequencies across the grid cannot
be globally synchronised by nearest-neighbour coupling at any setting the slider
offers. Measured across the whole slider range, order goes 0.010 → 0.019. What
coupling *does* change, and what the renderer deliberately draws, is **local**
agreement: the mean neighbour phase gap falls from 0.250 to 0.179, and it is that
local disagreement the brightness maps, so wavefronts glow as coupling organises
the grid.

So the panel reads **both** numbers: **Order** for the whole grid, and **Local
order** — synchrony inside 7×7 neighbourhoods — which is the one that moves when
you turn the dial. Measured live in the browser at coupling 0 → 40: Order
0.004 → 0.013 (nothing, correctly), Local order 0.150 → 0.230. Showing only the
global figure made the most responsive control in the app look dead.

Global synchrony is reachable in the engine — a near-uniform field closes its
phase gaps monotonically with coupling, which `tests/engine.test.js` asserts —
but not from random phases on a lattice this size under nearest-neighbour
coupling, which organises into domains and travelling waves instead. That is the
physics, and the reason the piece has texture rather than one dull unison.

## On a phone

The layout is viewport-driven, and below 880px the sidebar becomes a scrollable
sheet under the field so the canvas keeps the full width. Drag anywhere on the
field to conduct; **Hide** collapses the sheet and gives the field the whole
screen (373px to 762px of height on a 390×844 handset). Keyboard shortcuts still
work with a bluetooth keyboard but are not advertised on touch, where the help
list is hidden.

Touch specifics that are deliberate:

- `touch-action: none` on the canvas, or the browser eats the drag as a scroll
  or pinch and the instrument appears dead.
- Every button, slider and select meets 44px (WCAG 2.2 AAA); several were
  20–33px before the phone pass and effectively unusable with a thumb.
- Selects are 16px so iOS Safari does not zoom the page when one takes focus.
- The two hints stack in one bottom overlay rather than each being positioned
  individually: over a 198px landscape canvas they used to land on top of each
  other and of the note readout. Both retire in landscape entirely.
- Safe-area insets come from `env(safe-area-inset-*)` with `viewport-fit=cover`,
  so nothing sits under a notch or home indicator.

## How it works

| File | Role |
| --- | --- |
| `index.html` | **Generated** single file — what you open |
| `src/page.template.html` + `styles.css` | Hand-written markup and styling |
| `tools/build-standalone.mjs` | Bundles `src/main.js` (esbuild, IIFE) and inlines both into `index.html` |
| `src/field.js` | Oscillator grid: phase integration, sine-of-phase-difference coupling on a torus, strokes, order parameter |
| `music.js` | Continuous scale-degree → MIDI map; degree is measured in scale steps |
| `tuning.js` | Musical parameters → per-position firing rates |
| `scheduler.js` | Grid activity → note events, under a shared voice budget |
| `audio.js` | Web Audio voices, cross-coupled stereo delay, convolution reverb |
| `app.js` | Render loop, input, control wiring |

Two decisions worth knowing:

- **Phases advance as angular velocity**, so changing frequency glides instead
  of jumping, which is what keeps retuning and self-hearing click-free.
- **A cycle is detected by overshoot** (`phase + Δ ≥ 1`), not by comparing the
  wrapped value, because a phase of exactly `1.0` would wrap to `0` and be
  counted as a firing that never happened.

## Checks

```sh
./check.sh
```

Runs three phases: `deno check` (types over all ten modules), 64 unit tests
(physics, music, the HTML/JS boundary, the image comparator itself, and
`serve.py`'s address resolution), and 48 Playwright browser checks including
golden screenshots. Bootstrap the browser toolchain with:

```sh
nix-build gcroots.nix -A pw       --out-link .gc-roots/pw
nix-build gcroots.nix -A browsers --out-link .gc-roots/browsers
nix-build gcroots.nix -A node     --out-link .gc-roots/node
```

`BROWSERS=chromium` / `BROWSERS=firefox` restricts the engine used.

### Golden screenshots

`tests/golden/` holds six Firefox baselines: the `idle`, `wavefront` and
`locked` field poses plus `chrome` (the control panel), all captured at desktop
size, and `phone-portrait` / `phone-landscape` at 390×844 and 844×390. Every
pose is seeded with the clock stopped and one final paint, so an image has
exactly one correct result. Comparison is per-pixel with a 2% tolerance
(`PIXEL_TOLERANCE`), because rendering legitimately varies with GPU and font
antialiasing; `UPDATE=chrome ./check.sh` regenerates named baselines after an
intended change.

Name the images you mean rather than using `UPDATE=1`, which rewrites all six —
including the ones unrelated to your edit, silently absorbing any accidental
change hiding among them. `UPDATE=<pose>` matches on the short name (`idle`,
`chrome`, `phone-portrait`) or the full file name. Both forms are tested: a
corrupted `idle` is caught, and `UPDATE=idle` repairs that file alone.

The two phone baselines are captured on a **fresh page**, not from the page the
interactive phone checks have been tapping. That distinction is deliberate and
was a bug in the first version of this test: capturing after the interaction
checks baselined a collapsed sheet, a dismissed hint and the note readout left
over from a drag, which is both the wrong thing to guard and fragile to changes
in check order.

Each pose is the whole visible state, so `settlePose` also clears the note
readout. Without that, an image inherited whatever the previous interaction had
played and every baseline quietly enshrined a stale "C#4 · 60.6" over a field
nobody had touched — 0.24% of pixels, comfortably inside the 2% tolerance, so it
survived as a defect that no comparison would ever have caught.

The `locked` baseline is 97.7% a single colour, and that is the intended
rendering: brightness maps *local phase disagreement*, so a synchronised field
fades to flat by design. It is the weakest of the six signals for exactly that
reason; `idle` (1374 colours) and `wavefront` (luminance 8–249) carry the visual
regression coverage.

The comparator (`tests/png.mjs`) is a small PNG decoder over `node:zlib`, so
there is no image dependency; its own behaviour is pinned by `tests/png.test.mjs`,
including that a one-pixel change registers and that a size mismatch fails —
without those, a comparator that always returned 0 would make every screenshot
test vacuously pass.

The suite serves the project by intercepting requests rather than binding a
socket, so it runs inside a sandbox that forbids `bind()`. `.scratch/` holds
ad-hoc debugging scripts and is not part of the suite.

### What was actually observed

Run 2026-10-30 on this machine: `ALL CHECKS PASSED` — types clean, 64/64 unit +
wiring + serve tests, and 47/48 browser checks in Firefox (1 skipped, below).
Everything browser-level here is Firefox; see Limitations for why.

Specifically observed in-browser: zero page errors on load; canvas populated
(4704 lit pixels, many distinct colours, backing store equal to the grid);
render loop advancing; pointer drag injecting energy; keyboard updating the note
readout with row 2 sounding above row 1; command keys running their command
without sounding a note; every slider, select, checkbox and button responding
without throwing; pause freezing the clock exactly and run resuming it; strong
coupling sustaining order > 0.6; and the audio graph being built on the enable
gesture.
- **Observed visually:** screenshots are now captured and inspected. This found
  three things that pixel-array assertions had passed: synchronisation was
  invisible (a locked field drew as flat mid-blue, because absolute phase is a
  poor brightness signal — the renderer now maps *local phase disagreement*, so
  wavefronts glow and locking fades), the palette sat in such a narrow value
  range that the field read as one muddy colour, and the **Root select rendered
  blank** because state held the number `0` while the options held note names,
  so `select.value = "0"` matched nothing and any change wrote `""`. The note
  name is now the single representation.
- **Observed while developing:** the suite caught a dead `Coupling` import that
  made the page throw before painting anything, a canvas backing store sized to
  the CSS box while drawn at grid resolution (field rendered as a small patch
  on black), `bindSelect` writing the string `"0"` into the numeric root offset
  so pitch arithmetic concatenated instead of adding, and `maxVoices` never
  being enforced.
- **Skipped, not verified:** *"playback produces sound at the master bus"*.
  Firefox reports `sampleRate` 44100 but leaves the `AudioContext` suspended and
  `resume()` never settles (measured: still `suspended` after 1.5 s), because
  this headless sandbox exposes no output device. Audio *graph construction* is
  verified; audible output is **not**.
- **Untested expectation:** that sound is correct and pleasant on real hardware,
  and that it mixes sensibly with the field's own output at high voice counts.

- **Observed on phone viewports** (390×844 and 844×390, `hasTouch`/`isMobile`,
  Firefox): zero page errors; the field is never a sliver (368×373 portrait,
  822×198 landscape); no control under 44px; all 23 sheet controls reachable by
  scrolling; a synthesised `pointerType: "touch"` drag raises activity 0.0000 →
  0.1586; the touch hint appears and retires on the first gesture; hiding the
  sheet grows the canvas 373 → 762px and the button label and `aria-expanded`
  both follow. Screenshots at both sizes were inspected by eye, which is how the
  hint/readout overlap and a wrapped header were found and fixed.
- **Observed in the two no-fetch shapes:** the single file boots, paints and
  keeps animating from `file://` and from a `sandbox="allow-scripts"` iframe with
  an opaque origin and no base URL — the latter being what a Paseo preview pane
  does. Reverting the bundle to a plain `import` makes these checks fail, so they
  exercise the path rather than passing vacuously.
- **The screenshots are load-bearing, not decorative.** Three separate injected
  regressions were correctly rejected: reverting the bundle to an `import`
  failed the two no-fetch checks; hints positioned over the canvas again failed
  both phone baselines plus `idle`/`wavefront`/`locked`; an inverted field failed
  all five. Zeroing the disagreement term made `idle` differ by 69.7% of pixels
  and `wavefront` by 32.1% while `locked` and `chrome` correctly still passed,
  since that change cannot affect them. Repeated runs without `UPDATE=1`
  reproduce every baseline within tolerance, so they are deterministic rather
  than freshly captured and trusted.
- **Investigated and *not* a bug: the field never synchronises.** Chased because
  the field still read order 0.038 after 11 s at coupling 22, contradicting this
  README. Ruled out in turn: the coupling law is correct (near-uniform phase
  gaps close monotonically, 1.86e-2 → 5.22e-3 as coupling rises 0 → 30); it is
  not a `dt` scaling error (results are step-size independent); it is not a
  topological winding defect. The cause is the **tuning**: natural frequencies
  span 0.204–4.899 Hz across the grid, a ~24× spread that nearest-neighbour
  coupling cannot bridge, so global order stays ~0.01–0.02 at *every* slider
  position. Coupling does work locally — mean neighbour gap 0.250 → 0.179 — and
  that local signal is what the renderer draws. The defect was the promise, not
  the physics: the hint and this README both claimed the field "locks into one
  voice", which the musical tuning makes unreachable by design. Both now say so.
- **The test that should have caught it could not:** the existing entrainment
  test asserted only a *direction* (`coupled < uncoupled`), which a coupling term
  weakened 1000× still satisfies. It passed throughout. Replaced with assertions
  on magnitude and monotonicity, which do fail at 1000× weaker — verified by
  actually weakening it.
- **Tooling fix that came out of it:** `UPDATE=1` was all-or-six, and using it to
  refresh one panel screenshot silently re-baselined the other five, so any
  accidental change in them was destroyed rather than reported. `UPDATE=<pose>`
  now rewrites only what you name.

- **The stats panel is now covered.** No test read any row of Field State, so
  every one began as an en dash placeholder and a row wired to a misspelled id
  would have sat there blank forever. Two checks now assert each row leaves its
  placeholder, is well-formed (three decimals, a hex seed, a note name, an
  octave count), and that Local order actually rises with coupling *in the DOM*
  — the only surface a visitor sees, and the claim the readout exists to make.

## A methodology trap worth knowing

The browser suite serves `index.html` **from disk**. So after editing `src/`
without rebuilding, it tests the previous bundle and reports green on code that
no longer exists. This bit me for real: I froze the Local order readout to a
constant to prove my new test could fail, and it *passed* — not because the test
was weak, but because the built page still had the old code. Rebuilding and
re-running failed it correctly.

`tests/wiring.test.mjs` does catch the staleness, but as a separate failure that
only fires if you happen to run it. The browser suite now rebuilds `index.html`
itself before starting, which makes the mistake impossible rather than merely
detectable. Verified: edit `src/`, skip the build, and the suite fails on the new
behaviour instead of passing on the old.

- **Not verified at all:** Chromium and WebKit behaviour, audible output on real
  hardware, multi-touch/pinch, and long-run stability beyond a few seconds of
  frames.

## Limitations

- Sound requires a working audio device; if one is missing the UI says so and
  continues visuals-only instead of hanging.
- Chromium is untested: it cannot start in this sandbox at all (it calls
  `socketpair()` during startup, before its own `--no-sandbox` applies, and the
  seccomp filter denies it — `sandbox_host_linux.cc:41`, SIGTRAP). Firefox is the
  verified engine, so the golden images are Firefox-specific and named
  accordingly; expect them to differ on other GPUs and font stacks, which is why
  comparison is tolerant rather than exact.
- Coupling is nearest-neighbour on a 2-torus, so the field organises into waves
  rather than the near-1.0 global locking of an all-to-all network. That is the
  physics, not a shortfall; the tests assert against the disordered baseline.
- The field is a fixed 84×56; there is no resize or save/restore of settings.

## Next iteration

Make the **field the sequencer it is already almost being**: add per-cell
toggleable gate rows so a sustained gesture records a pattern of cells that
then drives the note scheduler with its own clock, and let a fired cell address
either pitch or a drum-ish noise voice. That turns the piece from "conducting
weather" into a loop-based instrument where the synchronisation dynamics become
the arrangement, which is the part that is genuinely surprising today. A
smaller, cheap predecessor: record and replay the pointer gesture as CV.
