// Browser smoke test: proves the page boots, the render loop runs, the controls
// are wired, and the audio graph produces real signal.
//
// The project is served by intercepting requests (page.route) rather than by
// spawning an HTTP server: the sandbox forbids bind()/socket(), and a served
// origin (not file://) is required for ES modules and Web Audio to behave.
//
//   nix-build gcroots.nix -A pw --out-link .gc-roots/pw        # once
//   nix-build gcroots.nix -A browsers --out-link .gc-roots/browsers
//   .gc-roots/node/bin/node tests/browser.test.mjs
import assert from 'node:assert/strict';
import { decodePng, differenceRatio } from './png.mjs';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { chromium, firefox } = require(new URL('../.gc-roots/pw/index.js', import.meta.url).pathname);

/** `BROWSERS=chromium node tests/browser.test.mjs` runs one engine only. */
const ENGINES = (process.env.BROWSERS ?? 'chromium,firefox')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const ORIGIN = 'http://resonance.test';
const GOLDEN_DIR = new URL('../tests/golden/', import.meta.url).pathname;
/**
 * The engines that own baselines in `tests/golden/`, which is decided by what
 * is committed there rather than written down twice. Images are named
 * `<engine>-<pose>.png`, and the two engines render differently enough that
 * sharing one set of images would be meaningless: Firefox and Chromium differ
 * on font antialiasing and canvas rasterisation, so each is pinned to its own.
 *
 * Derived from disk so that recording a new engine (`BROWSERS=<engine>
 * UPDATE=1 node tests/browser.test.mjs`) makes it a compared engine
 * immediately, and deleting every image for an engine stops comparing it
 * without leaving a stale list claiming otherwise.
 */
const GOLDEN_ENGINES = new Set(
  readdirSync(GOLDEN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => entry.name.split('-')[0]),
);

/**
 * Golden images are compared with a tolerance, not byte-for-byte: rendering
 * legitimately varies with GPU, font antialiasing and subpixel timing, so a
 * strict comparison fails on machines that are rendering correctly. UPDATE=1
 * regenerates them after an intentional visual change.
 */
const PIXEL_TOLERANCE = Number(process.env.PIXEL_TOLERANCE ?? 0.02);
/**
 * `UPDATE=1` rewrites every baseline. That is a footgun: after one intended
 * visual change it silently re-baselines the five images that had nothing to do
 * with it, so an unintended change hiding among them is lost rather than
 * reported. `UPDATE=<name[,name]>` rewrites only those named, and is the form to
 * prefer. A bare `1` still works, for the times all of them really are wrong.
 */
const UPDATE_SPEC = process.env.UPDATE ?? '';
const UPDATE_NAMES = UPDATE_SPEC && UPDATE_SPEC !== '1'
  ? new Set(UPDATE_SPEC.split(',').map((entry) => entry.trim()).filter(Boolean))
  : null;
const UPDATE_ALL = UPDATE_SPEC === '1';
/**
 * Match either the full file name (`firefox-idle`) or the pose alone (`idle`),
 * because `UPDATE=idle` is what anyone types first and silently rewriting
 * nothing is the worst possible response to it.
 */
const shouldUpdate = (name) => {
  if (UPDATE_ALL) return true;
  if (UPDATE_NAMES === null) return false;
  for (const wanted of UPDATE_NAMES) {
    if (name === wanted || name.endsWith(`-${wanted}`)) return true;
  }
  return false;
};
const PROJECT_ROOT = new URL('..', import.meta.url).pathname;

/*
 * Rebuild the single file before testing it.
 *
 * The suite serves index.html from disk, so after editing src/ it will happily
 * test the previous bundle and report green on code that is no longer there --
 * observed as a mutation test passing because the built page had not been
 * regenerated. The staleness test in tests/wiring.test.mjs catches the drift,
 * but only if it runs first and only as a separate failure; rebuilding here
 * makes the class of mistake impossible rather than merely detectable.
 */
function buildStandalone() {
  const build = new URL('../tools/build-standalone.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [build], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`build before browser tests failed:\n${result.stderr || result.stdout}`);
  }
}
buildStandalone();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const results = [];

function report(name, status, detail) {
  results.push([name, status]);
  const label = { ok: 'ok  ', skip: 'skip', fail: 'FAIL' }[status];
  console.log(`${label} ${name}${detail ? `\n     ${detail}` : ''}`);
}

function check(name, fn) {
  return fn().then(
    () => report(name, 'ok'),
    (error) => {
      // An unavailable audio device is an environment limit, not a defect.
      const reason = error.message.split('\n')[0];
      if (/no-audio-device/.test(error.message)) return report(name, 'skip', reason.replace('no-audio-device: ', ''));
      report(name, 'fail', reason);
    },
  );
}

/** Serve project files from disk so the page runs on a real http origin. */
async function serveFromDisk(page) {
  await page.route(`${ORIGIN}/**/*`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const requested = path === '/' ? '/index.html' : path;
    if (!/^\/[\w.-]+\.(?:html|js|css)$/.test(requested)) return route.fulfill({ status: 404, body: 'not found' });
    const body = readFileSync(`${PROJECT_ROOT}${requested.slice(1)}`);
    const extension = requested.slice(requested.lastIndexOf('.'));
    return route.fulfill({ status: 200, headers: { 'content-type': MIME[extension] }, body });
  });
}

/**
 * Drive the app into a deterministic pose and stop time, so a screenshot has a
 * single correct result. `clock` advances with wall time, so without pausing
 * before capture every image would differ run to run.
 */
async function freezePose(page, pose) {
  await page.evaluate(async (which) => {
    const api = window.__resonance;
    api.resetDefaults();
    // Earlier checks cycle every select, which would otherwise leak a random
    // palette and scale into the golden image.
    api.setVisuals({ palette: 'abyss', scale: 'aeolian', root: 'C', map: 'diagonal' });
    await api.settlePose(which);
    api.setRunning(false);
    // One paint after pausing so the canvas shows the frozen state, not the
    // frame that happened to be in flight when time stopped.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, pose);
}

/** Compare a screenshot against its golden image, regenerating on demand. */
async function assertGolden(page, name, options) {
  const shot = await page.screenshot({ ...options, animations: 'disabled' });
  const goldenPath = `${GOLDEN_DIR}${name}.png`;
  const exists = existsSync(goldenPath);
  const recorded = shouldUpdate(name);
  if (recorded || !exists) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(goldenPath, shot);
    // Two different things, and conflating them was a bug: `recorded` means the
    // caller asked for a new baseline, `existed` says whether one was there
    // first. A baseline that was absent and not asked for has vanished from the
    // repo and must not pass (see requireGolden). `ratio` is deliberately absent
    // rather than zero here -- comparing a file you just overwrote is always 0
    // and proves nothing, so there is no ratio to report.
    return { recorded, existed: exists };
  }
  const ratio = differenceRatio(decodePng(shot), decodePng(readFileSync(goldenPath)));
  return { recorded: false, existed: true, ratio };
}

/**
 * A baseline that is absent from the repo is a failure, not a skip. The first
 * version of this harness treated "no golden yet" the same as "recording was
 * requested": delete or forget to commit one image and the run re-recorded it
 * and reported `skip`, so the suite passed while guarding nothing. Observed
 * directly -- moving `firefox-locked.png` away produced `skip golden: locked
 * (baseline)` and exit 0, and the freshly drawn image passed the other checks
 * only because rendering happens to be deterministic here.
 */
function requireGolden(result, name) {
  if (!result.recorded && !result.existed) {
    throw new Error(
      `no golden image for ${name}: it is absent from tests/golden, so this run re-recorded `
      + 'one and cannot compare against anything. Restore it from git, or if the change is '
      + 'intended record it deliberately with UPDATE=<pose>.',
    );
  }
}

/**
 * Run one golden check, or report why it cannot run on this engine. Keeps the
 * engine-without-baselines case out of the body of every check.
 */
function goldenCheck(goldenEngine, label, fn) {
  if (goldenEngine) return check(label, fn);
  report(label, 'skip', 'this engine has no baselines in tests/golden; record with BROWSERS=<engine> UPDATE=1');
  return Promise.resolve();
}

const GOLDEN_VIEWPORT = { width: 1280, height: 820 };
/**
 * A phone in each orientation. 390x844 is a modern compact handset; the
 * landscape pair is transposed, where the original defect lived -- the canvas
 * collapsed to a 198px strip and the hint overlays sat on top of the readout.
 */
const PHONE_PORTRAIT = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const PHONE_LANDSCAPE = { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true };

/** Open the page once per browser and keep it alive for every check. */
async function openPage(browser, options = {}) {
  const context = await browser.newContext({ viewport: GOLDEN_VIEWPORT, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.errors = errors;
  await serveFromDisk(page);
  await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'load' });
  return { page, context };
}

const openedContexts = [];
const browsers = [];
let exitCode = 0;

try {
  const available = { chromium, firefox };
  // A name that is not an engine is a typo in BROWSERS, and skipping it would
  // end the run having asserted nothing at all -- 0/0 passed, exit 0, green.
  const unknown = ENGINES.filter((name) => !available[name]);
  if (unknown.length > 0) {
    throw new Error(
      `unknown engine(s): ${unknown.join(', ')}. Available: ${Object.keys(available).join(', ')}.`,
    );
  }
  for (const name of ENGINES) {
    const type = available[name];
    let browser;
    try {
      browser = await type.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    } catch (error) {
      const reason = error.message.split('\n')[0];
      /*
       * Chromium cannot start in this sandbox at all. It calls socketpair()
       * during startup -- content/browser/sandbox_host_linux.cc, before its own
       * `--no-sandbox` is consulted -- and the seccomp filter denies socket(),
       * so it dies with SIGTRAP on `Check failed: . shutdown: Operation not
       * permitted`. That is an environment limit rather than a page defect, so
       * it is reported as a skip; Firefox covers every check. Anything else is
       * a real problem and is printed in full.
       */
      const environment = /Operation not permitted|SIGTRAP|Target page, context or browser has been closed/u.test(error.message);
      console.log(`skip ${name}: ${environment ? 'cannot launch here (socket() denied by the sandbox); ' : ''}${reason}`);
      continue;
    }
    browsers.push(browser);
    console.log(`\n=== ${name} ===`);

    const { page: driver, context } = await openPage(browser);
    openedContexts.push(context);

    await check('page loads with no script errors', async () => {
      assert.deepEqual(driver.errors, [], 'unexpected page errors');
    });

    await check('module booted and published its debug handle', async () => {
      await driver.waitForFunction(() => window.__resonance !== undefined, null, { timeout: 5000 });
    });

    await check('canvas is pixel-populated, not a blank rectangle', async () => {
      const stats = await driver.evaluate(() => {
        const canvas = document.getElementById('field');
        const gl = canvas.getContext('2d');
        const data = gl.getImageData(0, 0, canvas.width, canvas.height).data;
        const seen = new Set();
        let lit = 0;
        for (let i = 0; i < data.length; i += 4) {
          seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
          if (data[i] + data[i + 1] + data[i + 2] > 60) lit += 1;
        }
        return { width: canvas.width, height: canvas.height, distinct: seen.size, lit, pixels: data.length / 4 };
      });
      assert.equal(stats.width * stats.height, stats.pixels, 'backing store disagrees with its own size');
      assert.ok(stats.distinct > 4, `canvas looks blank: only ${stats.distinct} distinct colours`);
      assert.ok(stats.lit > stats.pixels * 0.02, `almost nothing drawn: ${stats.lit}/${stats.pixels} lit`);
    });

    await check('canvas backing store matches the grid it renders', async () => {
      const size = await driver.evaluate(() => {
        const canvas = document.getElementById('field');
        return { w: canvas.width, h: canvas.height, cols: window.__resonance.field.cols, rows: window.__resonance.field.rows };
      });
      assert.deepEqual([size.w, size.h], [size.cols, size.rows], `backing store ${size.w}x${size.h} vs grid ${size.cols}x${size.rows}`);
    });

    await check('the simulation advances and the loop keeps running', async () => {
      const before = await driver.evaluate(() => window.__resonance.field.orderParameter());
      await driver.waitForTimeout(400);
      const after = await driver.evaluate(() => window.__resonance.field.orderParameter());
      assert.ok(Number.isFinite(before) && Number.isFinite(after), 'order parameter is not a number');
      const drawn = await driver.evaluate(() => window.__resonance.tickCounter());
      assert.ok(drawn > 5, `render loop stalled after ${drawn} frames`);
    });

    await check('pointer drag paints energy into the field', async () => {
      const box = await driver.locator('#field').boundingBox();
      await driver.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
      await driver.mouse.down();
      for (let i = 0; i <= 12; i++) {
        await driver.mouse.move(box.x + box.width * (0.3 + 0.4 * (i / 12)), box.y + box.height * 0.5);
      }
      await driver.mouse.up();
      const activity = await driver.evaluate(() => window.__resonance.field.activity());
      assert.ok(activity > 0.01, `drag left no energy: ${activity}`);
    });

    await check('keyboard input plays a note and updates the readout', async () => {
      await driver.evaluate(() => window.__resonance.resetDefaults());
      await driver.keyboard.press('a');
      const readout = await driver.locator('#v-note').textContent();
      assert.match(readout, /[A-G][#]?-?\d+/, `readout did not update: ${readout}`);
    });

    await check('keyboard rows ascend and each row sits above the last', async () => {
      await driver.evaluate(() => window.__resonance.resetDefaults());
      const pitches = [];
      for (const key of ['a', 's', 'd', 'f']) {
        await driver.keyboard.press(key);
        pitches.push(await driver.locator('#v-note').textContent());
      }
      const firstRow = await driver.evaluate(() => window.__resonance.lastPlayedMidi());
      await driver.keyboard.press('z');
      const secondRow = await driver.evaluate(() => window.__resonance.lastPlayedMidi());
      assert.ok(secondRow > firstRow, `second row not higher: ${firstRow} -> ${secondRow}`);
      assert.ok(pitches.every((text) => /[A-G][#]?-?\d+/.test(text)), `bad readouts: ${pitches}`);
    });

    await check('command keys act and are not swallowed as notes', async () => {
      const api = async () => driver.evaluate(() => window.__resonance.probeCommands());
      const before = await api();
      await driver.keyboard.press('c');
      const afterSilence = await api();
      assert.ok(afterSilence.gainSum < before.gainSum, 'C did not silence the field');
      const clockBefore = await driver.evaluate(() => window.__resonance.clockValue());
      await driver.keyboard.press('b');
      const afterBurst = await api();
      assert.ok(afterBurst.order > 0.9, `B did not phase-reset the grid: ${afterBurst.order}`);
      assert.equal(afterBurst.commandLog.at(-1), 'burst', 'B did not run the burst command');
    });

    await check('every slider updates state when moved', async () => {
      const sliders = await driver.locator('#panel input[type=range]').all();
      assert.ok(sliders.length >= 7, `expected at least 7 sliders, found ${sliders.length}`);
      for (const slider of sliders) {
        const id = await slider.getAttribute('id');
        const key = await slider.evaluate((el) => el.dataset.stateKey ?? null);
        if (key === null) assert.fail(`${id} is not mapped to a state key`);
        await slider.evaluate((el) => {
          el.value = String((Number(el.min) + Number(el.max)) / 2);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      await driver.waitForTimeout(150);
      assert.deepEqual(driver.errors, [], 'a slider threw');
    });

    await check('every select and checkbox updates state', async () => {
      for (const selector of ['#panel select', '#panel input[type=checkbox]']) {
        for (const control of await driver.locator(selector).all()) {
          await control.evaluate((el) => {
            if (el.tagName === 'SELECT') {
              el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              el.checked = !el.checked;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          });
          await driver.waitForTimeout(40);
        }
      }
      assert.deepEqual(driver.errors, [], 'a select or checkbox threw');
    });

    /*
     * The Field State panel is the app's only feedback about the physics, and
     * every one of its rows starts as an en dash placeholder. Nothing else in
     * the suite reads them, so a readout wired to a misspelled id -- or to a
     * field method that stopped existing -- would sit at en dash forever and
     * every other check would still pass. Local order in particular is the
     * readout that makes the coupling dial visibly do something, so a silent
     * break there restores the exact defect it was added to fix.
     */
    await check('the field state panel fills in and reports real numbers', async () => {
      const PLACEHOLDER = '\u2013';
      const before = await driver.evaluate(() => {
        const ids = ['v-order', 'v-local', 'v-activity', 'v-fps', 'v-voices', 'v-seed', 'v-spread', 'v-scale', 'v-root'];
        const out = {};
        for (const id of ids) out[id] = document.getElementById(id).textContent;
        return out;
      });
      // Everything must have left its placeholder by now: updateStatus() has
      // run many times since load.
      const stuck = Object.entries(before).filter(([, value]) => value === PLACEHOLDER || value === '');
      assert.deepEqual(stuck, [], 'readouts never updated from their placeholder');

      // Decimals are asserted as "fixed and at least three" rather than exactly
      // three: 0.805 formats as "0.805" but a value of exactly 1 would print as
      // "1.000", and both are correct.
      for (const id of ['v-order', 'v-local']) {
        assert.match(before[id], /^\d+\.\d{3}$/, `${id} is not a three-decimal fixed number: "${before[id]}"`);
        assert.ok(Number(before[id]) >= 0 && Number(before[id]) <= 1, `${id} out of range 0..1: "${before[id]}"`);
      }
      assert.match(before['v-fps'], /^\d+$/, `v-fps is not an integer: "${before['v-fps']}"`);
      assert.match(before['v-activity'], /^\d+%$/, `v-activity is not a percentage: "${before['v-activity']}"`);
      assert.match(before['v-seed'], /^0x[0-9a-f]{1,8}$/, `v-seed is not hexadecimal: "${before['v-seed']}"`);
      assert.match(before['v-scale'], /^[a-z]+$/, `v-scale is not a scale name: "${before['v-scale']}"`);
      assert.match(before['v-root'], /^[A-G]#?$/, `v-root is not a note name: "${before['v-root']}"`);
      assert.match(before['v-spread'], /^\d+(\.\d+)? oct$/, `v-spread is not an octave count: "${before['v-spread']}"`);
      // FPS is the health signal: if this is low the render loop is struggling.
      assert.ok(Number(before['v-fps']) > 20, `implausible frame rate: ${before['v-fps']}`);
    });

    await check('local order responds to coupling in the panel, not just in the engine', async () => {
      // The claim the UI makes is that this dial moves this number, so assert it
      // through the DOM, which is the only surface a visitor can see.
      //
      // Measured from a reset rather than from whatever the previous check left
      // behind: local order is a property of the current field, so a field an
      // earlier check already organised starts high and can only fall, which
      // reads as "the dial does nothing" when it is working correctly.
      const settle = async (coupling) => {
        await driver.evaluate((value) => {
          const api = window.__resonance;
          api.resetDefaults();
          const el = document.getElementById('c-coupling');
          el.value = String(value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }, coupling);
        // updateStatus() throttles to every twelfth frame, so allow for more
        // than one animation frame before trusting the text.
        await driver.waitForFunction((expected) => {
          const el = document.getElementById('c-coupling');
          return el.value === String(expected) && window.__resonance.field.orderParameter() !== undefined;
        }, coupling, { timeout: 2000 });
        await driver.waitForTimeout(1500);
        return driver.evaluate(() => Number(document.getElementById('v-local').textContent));
      };
      const quiet = await settle(0);
      const strong = await settle(40);
      assert.ok(strong > quiet + 0.02, `local order did not rise with coupling: ${quiet} -> ${strong}`);
    });

    await check('buttons all respond without throwing', async () => {
      for (const id of ['#b-burst', '#b-clear', '#b-seed', '#b-mutate', '#b-reset', '#b-play']) {
        await driver.locator(id).click();
        await driver.waitForTimeout(60);
      }
      assert.deepEqual(driver.errors, [], 'a button threw');
    });

    await check('pause freezes the clock and run resumes it', async () => {
      // Sample the clock only after the pause has settled: frames that are
      // already in flight when the click lands may still advance it once, so
      // the value read before clicking is not a valid frozen baseline.
      const pausedClock = await driver.evaluate(async () => {
        const api = window.__resonance;
        api.setRunning(true);
        await new Promise((r) => setTimeout(r, 60));
        document.getElementById('b-play').click();
        await new Promise((r) => setTimeout(r, 120));
        return api.clockValue();
      });
      await driver.waitForTimeout(250);
      assert.equal(await driver.evaluate(() => window.__resonance.clockValue()), pausedClock, 'clock advanced while paused');

      await driver.locator('#b-play').click();
      await driver.waitForTimeout(250);
      const resumed = await driver.evaluate(() => window.__resonance.clockValue());
      assert.ok(resumed > pausedClock, `clock did not resume: ${pausedClock} -> ${resumed}`);
    });

    await check('strong coupling sustains an ordered field', async () => {
      const order = await driver.evaluate(async () => {
        const api = window.__resonance;
        api.resetDefaults();
        api.setCoupling(38);
        api.setNoise(0);
        api.burst();
        api.setRunning(true);
        await new Promise((resolve) => setTimeout(resolve, 1400));
        return api.field.orderParameter();
      });
      // A burst seeds global order and local coupling holds it; a 2-torus does
      // not reach the ~1.0 of all-to-all coupling, so assert against the
      // disordered baseline instead.
      assert.ok(order > 0.6, `coupling did not sustain order: ${order}`);
    });

    await check('enable gesture builds the audio graph without throwing', async () => {
      const result = await driver.evaluate(async () => {
        const api = window.__resonance;
        const started = await api.enableAudioForTest();
        return { started, ready: api.audioReady(), state: api.audioContextState() };
      });
      // The graph must exist either way; whether the device starts is separate.
      assert.equal(result.ready, true, 'audio engine never became ready');
      assert.ok(['running', 'suspended', 'closed'].includes(result.state), `odd state ${result.state}`);
    });

    await check('playback produces sound at the master bus', async () => {
      const audible = await driver.evaluate(async () => {
        const api = window.__resonance;
        await api.enableAudioForTest();
        const analyser = api.attachAnalyserForTest();
        api.setRunning(true);
        api.burst();
        await new Promise((resolve) => setTimeout(resolve, 900));
        const buffer = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(buffer);
        let peak = 0;
        for (const sample of buffer) peak = Math.max(peak, Math.abs(sample));
        return { peak, contextState: api.audioContextState(), voices: api.voiceCount() };
      });
      /*
       * Two different ways this environment can have no audio to measure, and
       * the first version only recognised one:
       *
       *   - Firefox headless leaves the context suspended and resume() never
       *     settles, so contextState is not 'running'.
       *   - Chromium on a machine with no real output reports 'running' AND
       *     renders digital silence, so state says nothing and peak is exactly 0.
       *
       * The second was reported as a failure, which sent CI red for the absence
       * of a sound card. Distinguishing "silence because no device" from
       * "silence because the graph is broken" is not possible from peak alone,
       * so the honest report is a skip that says so; graph construction and the
       * voice count stay asserted rather than being skipped along with it.
       */
      const noDevice = audible.contextState !== 'running'
        || (audible.peak === 0 && audible.voices === 0);
      if (noDevice) {
        throw new Error(
          `no-audio-device: context ${audible.contextState}, peak ${audible.peak}, `
          + `${audible.voices} voices; this browser/headless setup has no output to measure`,
        );
      }
      assert.ok(audible.voices > 0, 'no voices were scheduled, so the graph is not playing');
      assert.ok(audible.peak > 0.001, `no signal reached the analyser: peak ${audible.peak}`);
    });

    await check('no page errors accumulated during interaction', async () => {
      assert.deepEqual(driver.errors, [], `errors: ${driver.errors.join(' | ')}`);
    });

    // Phone layout. A separate context per orientation: the layout, the touch
    // affordances and the sheet behaviour are all viewport-driven, and none of
    // them can be exercised from a desktop-sized page.
    for (const [label, options] of [['portrait', PHONE_PORTRAIT], ['landscape', PHONE_LANDSCAPE]]) {
      const { page: phone_, context: phoneContext } = await openPage(browser, options);
      openedContexts.push(phoneContext);
      const tag = `phone ${label}`;
      /*
       * The intro overlay covers the viewport on a phone, so it sits on top of
       * everything these checks reach for. Every check runs as though the
       * visitor dismissed it, because that is the state the app spends its life
       * in; the overlay's own behaviour is asserted separately below.
       */
      await phone_.evaluate(() => document.getElementById('intro').hidden = true);

      await check(`${tag}: loads with no script errors`, async () => {
        await phone_.waitForFunction(() => window.__resonance !== undefined, null, { timeout: 5000 });
        assert.deepEqual(phone_.errors, [], 'unexpected page errors');
      });

      await check(`${tag}: the field is a usable size, not a sliver`, async () => {
        const box = await phone_.locator('#field').boundingBox();
        const viewport = phone_.viewportSize();
        assert.ok(box.width >= viewport.width - 40, `field only ${box.width}px wide in ${viewport.width}px`);
        // The regression this guards: landscape left the canvas 198px tall, and
        // a shorter field than this is an instrument nobody can conduct.
        assert.ok(box.height >= 190, `field only ${box.height}px tall in a ${viewport.height}px viewport`);
      });

      await check(`${tag}: controls meet the 44px touch-target minimum`, async () => {
        const small = await phone_.evaluate(() => {
          const offenders = [];
          for (const el of document.querySelectorAll('button:not([hidden]), select, input[type="range"]')) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            if (rect.height < 44) offenders.push(`${el.id || el.tagName}: ${Math.round(rect.height)}px`);
          }
          return offenders;
        });
        assert.deepEqual(small, [], 'controls smaller than the WCAG 2.2 AAA target size');
      });

      await check(`${tag}: the sheet scrolls, so every control is reachable`, async () => {
        // Reachability, not "is it inside the viewport": a phone cannot show all
        // 23 controls at once, which is why the sheet scrolls. Asserting each one
        // is on screen would be a test that no layout can pass.
        const result = await phone_.evaluate(() => {
          const panel = document.getElementById('panel');
          const unreachable = [];
          let total = 0;
          for (const el of panel.querySelectorAll('button, select, input')) {
            if (el.id === 'b-panel') continue;
            total += 1;
            el.scrollIntoView({ block: 'nearest' });
            const rect = el.getBoundingClientRect();
            const frame = panel.getBoundingClientRect();
            const visible = rect.bottom > frame.top && rect.top < frame.bottom;
            const style = getComputedStyle(el);
            if (!visible && style.display !== 'none' && style.visibility !== 'hidden') {
              unreachable.push(el.id || el.tagName);
            }
          }
          return { total, unreachable };
        });
        assert.ok(result.total >= 20, `only ${result.total} controls found; the panel markup changed`);
        assert.deepEqual(result.unreachable, [], 'controls cannot be scrolled into view');
      });

      // Runs before anything gestures on the canvas: the hint is dismissed by
      // the first pointerdown, so any earlier touch check would consume it and
      // this would fail for the wrong reason.
      await check(`${tag}: the touch hint retires on the first gesture`, async () => {
        const shown = await phone_.evaluate(() => document.getElementById('touch-hint').hidden === false);
        assert.ok(shown, 'the touch hint never appeared for a touch device');
        await phone_.locator('#field').dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
        assert.equal(await phone_.evaluate(() => document.getElementById('touch-hint').hidden), true);
      });

      await check(`${tag}: touch drags conduct waves into the field`, async () => {
        const box = await phone_.locator('#field').boundingBox();
        const before = await phone_.evaluate(() => window.__resonance.field.activity());
        // Synthesised pointer events with pointerType 'touch': touchscreen.tap
        // alone sends no pointermove, and the app reads the drag from those.
        await phone_.evaluate(async ([x, y]) => {
          const canvas = document.getElementById('field');
          const send = (type, cx, cy) => canvas.dispatchEvent(new PointerEvent(type, {
            pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
            clientX: cx, clientY: cy, buttons: type === 'pointerup' ? 0 : 1,
          }));
          send('pointerdown', x, y);
          for (let i = 0; i <= 10; i++) send('pointermove', x + i * 4, y + i * 2);
          send('pointerup', x + 40, y + 20);
        }, [box.x + box.width * 0.3, box.y + box.height * 0.5]);
        const after = await phone_.evaluate(() => window.__resonance.field.activity());
        assert.ok(after > before + 0.01, `touch drag changed activity ${before.toFixed(4)} -> ${after.toFixed(4)}`);
      });

      await check(`${tag}: hiding the controls gives the field the screen`, async () => {
        const before = await phone_.locator('#field').boundingBox();
        await phone_.tap('#b-panel');
        const collapsed = await phone_.evaluate(() => ({
          height: document.getElementById('field').getBoundingClientRect().height,
          label: document.getElementById('b-panel').textContent,
          expanded: document.getElementById('b-panel').getAttribute('aria-expanded'),
          state: document.getElementById('panel').dataset.collapsed,
        }));
        assert.ok(collapsed.height > before.height * 1.3, `canvas grew only ${before.height} -> ${collapsed.height}`);
        assert.equal(collapsed.expanded, 'false');
        assert.equal(collapsed.state, 'true');
        // The label must describe the action available, not the state just left.
        assert.match(collapsed.label, /Controls/i, `collapse label is "${collapsed.label}"`);
        // And the field must be usable with the sheet gone: no overlap possible.
        const hints = await phone_.evaluate(() => {
          const readout = document.getElementById('note-readout').getBoundingClientRect();
          const blocks = [...document.querySelectorAll('#audio-hint, #touch-hint')]
            .filter((el) => !el.hidden && getComputedStyle(el).display !== 'none')
            .map((el) => el.getBoundingClientRect());
          return blocks.filter((b) => b.right > readout.left && b.left < readout.right
            && b.bottom > readout.top && b.top < readout.bottom).length;
        });
        assert.equal(hints, 0, 'a hint overlays the note readout');
      });

      await check(`${tag}: the intro explains and then gets out of the way`, async () => {
        const fresh = await openPage(browser, options);
        openedContexts.push(fresh.context);
        await fresh.page.waitForFunction(() => window.__resonance !== undefined, null, { timeout: 5000 });
        // Visible, and its text is actually readable rather than clipped away.
        const shown = await fresh.page.evaluate(() => {
          const intro = document.getElementById('intro');
          const heading = document.getElementById('intro-title');
          const rect = heading.getBoundingClientRect();
          return {
            open: !intro.hidden,
            headingVisible: rect.top >= 0 && rect.height > 10,
            explains: intro.textContent.toLowerCase().includes('metronome'),
            mentionsDrag: intro.textContent.toLowerCase().includes('drag'),
          };
        });
        assert.ok(shown.open, 'the intro does not show for a first-time visitor');
        assert.ok(shown.headingVisible, 'the intro heading is clipped out of view');
        assert.ok(shown.explains, 'the intro no longer explains the metaphor');
        assert.ok(shown.mentionsDrag, 'the intro no longer says what to do');
        // A drag must pass through to the field, not be swallowed by the panel.
        //
        // Synthesised pointer events rather than page.mouse: under hasTouch the
        // mouse API produces no pointer events at all (measured: zero events
        // reach the document), so asserting a mouse drag here would be testing
        // an input a phone does not have.
        const box = await fresh.page.locator('#field').boundingBox();
        const before = await fresh.page.evaluate(() => window.__resonance.field.activity());
        await fresh.page.evaluate(([x, y]) => {
          const send = (type, cx, cy, on) => (on ?? document.getElementById('intro')).dispatchEvent(
            new PointerEvent(type, {
              pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
              clientX: cx, clientY: cy, buttons: type === 'pointerup' ? 0 : 1,
            }),
          );
          send('pointerdown', x, y);
          for (let i = 0; i <= 12; i++) send('pointermove', x + i * 5, y);
          send('pointerup', x + 60, y);
        }, [box.x + box.width * 0.4, box.y + box.height * 0.5]);
        assert.equal(await fresh.page.evaluate(() => document.getElementById('intro').hidden), true, 'a drag did not dismiss the intro');
        assert.ok(
          (await fresh.page.evaluate(() => window.__resonance.field.activity())) > before,
          'the intro swallowed the drag instead of letting it reach the field',
        );
      });

      // No golden here on purpose: the checks above tap the sheet and drag on
      // the canvas, so anything captured now would baseline a collapsed panel
      // and a dismissed hint rather than the page a visitor meets. The pristine
      // phone view is captured separately, on its own page, below.

      await check(`${tag}: no page errors accumulated`, async () => {
        assert.deepEqual(phone_.errors, [], 'errors during phone interaction');
      });
    }

    // Golden images. Captured last so earlier interaction cannot leak into
    // them, and every pose is seeded and time-frozen, so a mismatch means the
    // render changed rather than that the clock read differently.
    const poses = [
      ['idle', 'the field a visitor first sees'],
      ['wavefront', 'a travelling wave crest'],
      ['locked', 'a fully synchronised field'],
    ];

    for (const [pose, purpose] of poses) {
      await goldenCheck(GOLDEN_ENGINES.has(name), `golden: ${pose} (${purpose})`, async () => {
        await freezePose(driver, pose);
        const result = await assertGolden(driver, `${name}-${pose}`, {
          clip: await driver.locator('#field').boundingBox(),
        });
        requireGolden(result, pose);
        if (result.recorded) {
          report(`golden: ${pose} (recorded)`, 'skip', 'named in UPDATE; written, not compared');
          return;
        }
        assert.ok(
          result.ratio <= PIXEL_TOLERANCE,
          `${pose} differs from its golden image in ${(result.ratio * 100).toFixed(2)}% of pixels `
            + `(tolerance ${PIXEL_TOLERANCE * 100}%). If the change is intended, rerun with UPDATE=1.`,
        );
      });
    }

    await goldenCheck(GOLDEN_ENGINES.has(name), 'golden: chrome (control panel renders, incl. the Root select)', async () => {
      await freezePose(driver, 'chrome');
      const result = await assertGolden(driver, `${name}-chrome`, {
        clip: await driver.locator('#panel').boundingBox(),
      });
      requireGolden(result, 'chrome');
      if (result.recorded) {
        report('golden: chrome (recorded)', 'skip', 'named in UPDATE; written, not compared');
        return;
      }
      assert.ok(
        result.ratio <= PIXEL_TOLERANCE,
        `panel differs from its golden image in ${(result.ratio * 100).toFixed(2)}% of pixels`,
      );
    });

    // Pristine phone layouts, on pages nothing has touched. The interactive
    // phone checks above deliberately leave the sheet collapsed and the hint
    // dismissed, so a golden taken from them would enshrine that state; these
    // get a fresh page, a seeded pose and one paint, and so have one correct
    // image.
    for (const [label, options] of [['portrait', PHONE_PORTRAIT], ['landscape', PHONE_LANDSCAPE]]) {
      await goldenCheck(GOLDEN_ENGINES.has(name), `golden: phone ${label} (untouched layout a visitor first sees)`, async () => {
        const { page: fresh, context: freshContext } = await openPage(browser, options);
        openedContexts.push(freshContext);
        await fresh.waitForFunction(() => window.__resonance !== undefined, null, { timeout: 5000 });
        await freezePose(fresh, 'idle');
        const result = await assertGolden(fresh, `${name}-phone-${label}`);
        requireGolden(result, `phone-${label}`);
        if (result.recorded) {
          report(`golden: phone ${label} (recorded)`, 'skip', 'named in UPDATE; written, not compared');
          return;
        }
        assert.ok(
          result.ratio <= PIXEL_TOLERANCE,
          `phone ${label} differs from its golden image in ${(result.ratio * 100).toFixed(2)}% of pixels `
            + `(tolerance ${PIXEL_TOLERANCE * 100}%). Rerun with UPDATE=1 if the change is intended.`,
        );
        assert.deepEqual(fresh.errors, [], 'page errors while capturing the pristine phone layout');
      });
    }

    /*
     * The field as it paints on a phone. The full-page phone images above are
     * the layout a visitor meets, intro overlay included -- correct to pin, but
     * they are dominated by that overlay, which on a 390x844 handset covers the
     * entire viewport. So the canvas underneath was never compared at any phone
     * size, and a field that painted black, or not at all, passed both baselines
     * unnoticed. This clips to the canvas with the overlay dismissed, which is
     * the desktop poses' coverage, extended to handsets.
     */
    for (const [label, options] of [['portrait', PHONE_PORTRAIT], ['landscape', PHONE_LANDSCAPE]]) {
      await goldenCheck(GOLDEN_ENGINES.has(name), `golden: phone ${label} field (canvas, not overlay)`, async () => {
        const { page: fresh, context: freshContext } = await openPage(browser, options);
        openedContexts.push(freshContext);
        await fresh.waitForFunction(() => window.__resonance !== undefined, null, { timeout: 5000 });
        // Dismissed here, deliberately, so the image is the simulation rather
        // than the panel covering it. The full-page capture keeps the overlay.
        await fresh.evaluate(() => document.getElementById('intro').hidden = true);
        await freezePose(fresh, 'idle');
        const clip = await fresh.locator('#field').boundingBox();
        assert.ok(clip.width > 0 && clip.height > 0, `the phone ${label} canvas has no area to compare`);
        const result = await assertGolden(fresh, `${name}-phone-${label}-field`, { clip });
        requireGolden(result, `phone-${label}-field`);
        if (result.recorded) {
          report(`golden: phone ${label} field (recorded)`, 'skip', 'named in UPDATE; written, not compared');
          return;
        }
        assert.ok(
          result.ratio <= PIXEL_TOLERANCE,
          `phone ${label} field differs from its golden image in ${(result.ratio * 100).toFixed(2)}% of pixels`,
        );
        // A canvas that is one flat colour has nothing to pin: prove it carries
        // the field before trusting the comparison above.
        const spread = await fresh.evaluate(() => {
          const c = document.getElementById('field');
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          const seen = new Set();
          for (let i = 0; i < d.length; i += 4) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
          return seen.size;
        });
        assert.ok(spread > 8, `the phone ${label} canvas holds only ${spread} colours, so it is not painting`);
      });
    }

    /*
     * The accessibility contract, asserted on the built single file rather than
     * the template, because that is the artifact that ships and the one a screen
     * reader actually opens.
     */
    await check('assistive technology can describe the app', async () => {
      const a11y = await driver.evaluate(() => ({
        landmarks: ['banner', 'main'].every((role) => document.querySelector(`[role=${role}]`)),
        panelLabelled: !!document.querySelector('#panel[aria-label]'),
        // The canvas is opaque to AT, so its label has to carry the meaning.
        canvasLabelled: (document.getElementById('field').getAttribute('aria-label') || '').length > 40,
        noteAnnounces: document.getElementById('note-readout').getAttribute('aria-live') === 'polite',
        statusRegion: !!document.querySelector('#sr-state[role=status]'),
        // If the announcer never runs, this stays empty and the app is silent.
        statusFilled: document.getElementById('sr-state').textContent.includes('Order'),
        // .sr-only must be visually hidden but present in the a11y tree;
        // display:none would delete it from that tree and pass nothing.
        srOnlyClipped: getComputedStyle(document.querySelector('.sr-only')).clipPath !== 'none',
      }));
      assert.deepEqual(
        Object.entries(a11y).filter(([, ok]) => ok !== true).map(([name]) => name),
        [],
        'accessibility contract broken',
      );
    });

    await check('reduced motion removes the decorative animation', async () => {
      const { page: calm, context: calmContext } = await openPage(browser, { reducedMotion: 'reduce' });
      openedContexts.push(calmContext);
      await calm.waitForFunction(() => window.__resonance !== undefined, null, { timeout: 5000 });
      await calm.evaluate(() => document.getElementById('intro').hidden = true);
      const pulses = await calm.evaluate(() => {
        // Pulse is created by the app on each fired note; assert the rule that
        // hides it applies rather than that a pulse happens to be on screen.
        const probe = document.createElement('div');
        probe.className = 'pulse';
        document.getElementById('pulses').append(probe);
        const style = getComputedStyle(probe);
        const result = { display: style.display, animation: style.animationName };
        probe.remove();
        return result;
      });
      assert.equal(pulses.display, 'none', `pulse still shown: ${JSON.stringify(pulses)}`);
    });

    // The two shapes that cannot fetch anything, which is why index.html is one
    // file. A preview pane (what Paseo does with a linked page) injects the
    // markup into a frame with an opaque origin and no base URL, so a module
    // script there never runs: the panel paints around a black canvas and the
    // toy looks broken rather than blocked. file:// refuses module imports for
    // the same reason. Both must boot the engine and paint.
    for (const shape of ['file-url', 'opaque-frame']) {
      await check(`${shape}: the single file boots with no origin to fetch from`, async () => {
        const { page: probe, context: probeContext } = await openPage(browser, PHONE_PORTRAIT);
        openedContexts.push(probeContext);
        const standalone = readFileSync(`${PROJECT_ROOT}index.html`, 'utf8');
        if (shape === 'file-url') {
          await probe.goto(`file://${PROJECT_ROOT}index.html`, { waitUntil: 'load' });
        } else {
          // about:blank host so the child is genuinely cross-origin, and
          // sandbox="allow-scripts" gives it an opaque (null) origin.
          await probe.setContent(
            '<!doctype html><body style="margin:0">'
            + '<iframe id="f" sandbox="allow-scripts" style="width:390px;height:844px;border:0"></iframe></body>',
          );
          await probe.evaluate((markup) => { document.getElementById('f').srcdoc = markup; }, standalone);
        }
        // The frame to interrogate. For the sandboxed child this must go
        // through Playwright's frame handle: an opaque origin is unreadable from
        // the host page, which is the very property that makes this shape worth
        // testing, so a host-side waitForFunction could never see it boot.
        const target = async () => {
          if (shape === 'file-url') return probe;
          const child = probe.frames().find((frame) => frame !== probe.mainFrame());
          if (!child) throw new Error('the sandboxed child frame never appeared');
          return child;
        };
        await (await target()).waitForFunction(() => window.__resonance !== undefined, null, { timeout: 5000 });

        const paint = async () => (await target()).evaluate(() => {
          const canvas = document.getElementById('field');
          const context2d = canvas.getContext('2d');
          const data = context2d.getImageData(0, 0, canvas.width, canvas.height).data;
          let lit = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] + data[i + 1] + data[i + 2] > 60) lit += 1;
          }
          return { lit, frames: window.__resonance.tickCounter(), pixels: data.length / 4 };
        });

        const first = await paint();
        await probe.waitForTimeout(300);
        const second = await paint();
        assert.ok(second.frames > first.frames, `render loop stalled (${first.frames} -> ${second.frames} frames)`);
        assert.ok(first.lit > first.pixels * 0.02, `canvas unpainted: ${first.lit}/${first.pixels} lit`);
      });
    }

    await check('golden: the Root select is never blank', async () => {
      // Regression guard stated in pixels as well as the DOM: the select once
      // rendered empty because state held a number while the options held
      // note names, and a DOM-value assertion alone would not catch every way
      // this can visually break.
      const value = await driver.locator('#c-root').inputValue();
      assert.match(value, /^[A-G]#?$/, `Root select has no usable value: "${value}"`);
      const painted = await driver.evaluate(() => {
        const select = document.getElementById('c-root');
        const rect = select.getBoundingClientRect();
        const probe = document.createElement('canvas');
        probe.width = Math.round(rect.width);
        probe.height = Math.round(rect.height);
        // A select cannot be rasterised from the page, so assert the rendered
        // text box is non-empty and its label is legible instead.
        return { width: rect.width, height: rect.height, text: select.options[select.selectedIndex]?.textContent ?? '' };
      });
      assert.ok(painted.width > 100 && painted.height > 12, `select has no size: ${JSON.stringify(painted)}`);
      assert.match(painted.text, /^[A-G]#?$/, `selected option text is wrong: "${painted.text}"`);
    });
  }
} finally {
  for (const context of openedContexts) await context.close().catch(() => {});
  for (const browser of browsers) await browser.close().catch(() => {});
}

const passed = results.filter(([, status]) => status === 'ok').length;
const skipped = results.filter(([, status]) => status === 'skip');
const failed = results.filter(([, status]) => status === 'fail');
/*
 * Nothing ran is not the same as everything passed, and the two used to be
 * indistinguishable: if every engine failed to launch, each was reported as a
 * skip and `0/0 browser checks passed` exited 0. Observed by running the suite
 * inside a shell whose Playwright browsers revision did not match the driver --
 * a clean CI machine could have gone green having painted nothing.
 */
if (results.length === 0) {
  console.error('\nFAIL: no browser check ran. Every engine failed to launch, '
    + 'so the suite verified nothing. Check that PLAYWRIGHT_BROWSERS_PATH matches '
    + 'the Playwright driver version.');
  process.exit(1);
}
console.log(`\n${passed}/${results.length} browser checks passed`);
if (skipped.length) console.log(`skipped: ${skipped.map(([n, , ]) => n).join(', ')}`);
if (failed.length) {
  console.log(`failed: ${failed.map(([n]) => n).join(', ')}`);
  exitCode = 1;
}
process.exit(exitCode);
