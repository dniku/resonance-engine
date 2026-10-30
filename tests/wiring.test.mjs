// Guards the HTML/JS boundary. A typo in a control id is a dead slider or an
// exception at load, which no logic test in engine.test.js can see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { renderStandalone } from '../tools/build-standalone.mjs';

const root = new URL('..', import.meta.url).pathname;

/** The committed index.html must be byte-identical to a fresh build. */
async function assertStandaloneCurrent() {
  const committed = readFileSync(`${root}index.html`, 'utf8');
  const built = renderStandalone();
  assert.equal(
    committed,
    built,
    'index.html is stale: run `node tools/build-standalone.mjs` and commit the result',
  );
  assert.ok(
    !/(src|href)="(?!data:)[^"]+"/.test(built),
    'the single file references something external and would break off-server',
  );
}
// The template is the hand-written markup; index.html is generated from it. The
// boundary test belongs to the source, since that is what an edit can break.
const html = readFileSync(`${root}src/page.template.html`, 'utf8');
const app = readFileSync(`${root}src/app.js`, 'utf8');

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

// Ids named directly, plus every id appearing in a control-key table.
const literalIds = [...app.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
// Control-key tables look like ['c-tempo', 'tempo', Number]; the id is first.
const tableIds = [...app.matchAll(/\['(c-[a-z-]+|b-[a-z-]+)',\s*'([a-zA-Z]+)'/g)].map((m) => m[1]);
const knownIds = new Set([...literalIds, ...tableIds]);

test('every id app.js looks up exists in the page', () => {
  const missing = [...knownIds].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `app.js looks up ids the page does not define: ${missing}`);
});

test('every page control is known to app.js', () => {
  const declared = [...html.matchAll(/id="((?:c|b)-[a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(declared.length >= 18, `expected a full control surface, found ${declared.length}`);
  const orphaned = declared.filter((id) => !knownIds.has(id));
  assert.deepEqual(orphaned, [], `page declares controls app.js never touches: ${orphaned}`);
});

test('every range output follows the v-<control id> convention bindRange expects', () => {
  const sliders = [...html.matchAll(/<input id="(c-[a-z-]+)" type="range"/g)].map((m) => m[1]);
  const outputs = new Set([...html.matchAll(/<output id="([^"]+)"/g)].map((m) => m[1]));
  const unlabeled = sliders.filter((id) => !outputs.has(`v-${id}`));
  assert.deepEqual(unlabeled, [], `sliders with no matching v- output: ${unlabeled}`);
});

test('the control-key tables drive distinct state keys', () => {
  const pairs = [...app.matchAll(/\['(c-[a-z-]+|b-[a-z-]+)',\s*'([a-zA-Z]+)'/g)]
    .map((m) => [m[1], m[2]]);
  const keys = pairs.map((p) => p[1]);
  assert.equal(new Set(keys).size, keys.length, `two controls write the same state key: ${pairs}`);
});

// The browser caught a page that loaded but threw: app.js imported a name that
// constants.js no longer exported. That kills the whole app and no other test
// in the suite would have noticed, so assert the import graph resolves.
test('every import resolves against the exporting module', async () => {
  const modules = ['app', 'main', 'audio', 'field', 'music', 'scheduler', 'tuning', 'palette', 'mathx', 'constants'];
  const exported = new Map();
  for (const name of modules) {
    const source = readFileSync(`${root}src/${name}.js`, 'utf8');
    const names = new Set([
      ...[...source.matchAll(/^export (?:const|function|class|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]),
      ...[...source.matchAll(/^export \{([^}]*)\}/gm)].flatMap((m) => m[1].split(',').map((v) => v.trim().split(/\s+as\s+/).pop())),
    ]);
    exported.set(`${name}.js`, names);
  }
  const problems = [];
  for (const name of modules) {
    const source = readFileSync(`${root}src/${name}.js`, 'utf8');
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w.-]+)'/g)) {
      const target = match[2];
      if (!exported.has(target)) {
        problems.push(`${name}.js imports from missing module ./${target}`);
        continue;
      }
      for (const raw of match[1].split(',')) {
        const imported = raw.trim().split(/\s+as\s+/)[0];
        if (!imported) continue;
        if (!exported.get(target).has(imported)) {
          problems.push(`${name}.js imports '${imported}' from ./${target}, which does not export it`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], `broken imports: ${problems.join('; ')}`);
});

test('the template loads exactly one module and one stylesheet', () => {
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['src/main.js']);
  assert.match(html, /<script type="module" src="src\/main\.js"><\/script>/);
  assert.match(html, /rel="stylesheet" href="styles\.css"/);
});

// The two representations of the app must not drift: a generated page that is
// stale, or that fetched something, is the exact failure the single file exists
// to avoid.
test('the generated single file is current and self-contained', () =>
  assertStandaloneCurrent());

// Regression: each hint was its own absolutely positioned overlay, and in
// landscape (a ~200px canvas) they landed on top of each other and on the note
// readout. A shared flex container cannot overlap by construction.
test('the overlays stack rather than floating independently', () => {
  const css = readFileSync(`${root}styles.css`, 'utf8');
  const container = /#hints\s*\{([^}]*)\}/u.exec(css);
  assert.ok(container, 'no #hints container: the overlays are positioned individually again');
  const body = container[1];
  assert.match(body, /position:\s*absolute/u, 'the hint container must be out of flow');
  assert.match(body, /display:\s*flex/u, 'the hints must share one stacking context');
  assert.match(body, /flex-direction:\s*column/u, 'the hints must stack vertically');
  assert.match(body, /pointer-events:\s*none/u, 'an overlay must never swallow a drag on the field');
  // The readout keeps the top-left corner to itself.
  assert.match(css, /#hints[\s\S]*?bottom:\s*10px/u, 'hints belong at the foot of the stage');
});

/*
 * There must be exactly one openable HTML file, and it must be the built one.
 *
 * Opening the template directly is a silent failure: the stylesheet and module
 * are relative paths that resolve to nothing, so it paints bare controls around
 * a dead canvas and logs nothing -- observed as an unstyled page in a preview
 * pane, with no console output to explain it. So the template is named
 * *.template.html, no other source .html may exist, and it must warn in the
 * page itself when opened.
 */
test('only the built page is openable, and the template says so', () => {
  // Walked from the tree rather than from git: the invariant is about the files,
  // and this repo need not be a checkout for it to hold.
  const sourceHtml = readdirSync(`${root}src`)
    .filter((name) => name.endsWith('.html'))
    .map((name) => `src/${name}`);
  for (const file of sourceHtml) {
    assert.ok(
      file.endsWith('.template.html'),
      `${file} looks like a page but cannot work as one; name it *.template.html`,
    );
  }
  const template = readFileSync(`${root}src/page.template.html`, 'utf8');
  assert.ok(
    /class="not-a-page"/u.test(template),
    'the template no longer warns when opened directly',
  );
  // The rule that hides the warning in the built page. Without it the built page
  // would show the notice, which is the opposite failure.
  const css = readFileSync(`${root}styles.css`, 'utf8');
  assert.match(css, /\.not-a-page\s*\{\s*display:\s*none/u, 'styles.css must hide the template marker');
});

test('mobile layout is defined in CSS, not left to the desktop grid', () => {
  const css = readFileSync(`${root}styles.css`, 'utf8');
  assert.match(css, /@media \(max-width: 880px\)/, 'no phone breakpoint');
  assert.match(css, /touch-action:\s*none/, 'canvas must opt out of browser gestures');
  assert.match(css, /height:\s*100dvh/, 'must use dvh so the URL bar does not break layout');
  assert.match(css, /env\(safe-area-inset-bottom\)/, 'must respect the notch and home indicator');
  assert.match(css, /--tap:\s*44px/, 'touch targets must be at least 44px');
});

test('every golden pose has a baseline for each baselined engine', () => {
  // tests/golden is the source of truth for which engines are compared, and the
  // browser suite derives its engine set from the same directory. Both sides of
  // that agreement are asserted here, in the browser-free suite, because the
  // failure it prevents is invisible where it happens: a hard-coded engine list
  // that lags the directory turns real comparisons into silent skips. Observed
  // with Chromium -- six baselines committed, the list still Firefox-only, and
  // `BROWSERS=chromium` reported six "no baselines" skips while passing.
  const files = readdirSync(`${root}tests/golden`, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => entry.name);
  assert.ok(files.length > 0, 'tests/golden holds no baselines at all');

  const engines = new Set(files.map((name) => name.split('-')[0]));
  const posesByEngine = new Map(
    [...engines].map((engine) => [
      engine,
      new Set(files.filter((n) => n.startsWith(`${engine}-`)).map((n) => n.slice(engine.length + 1, -4))),
    ]),
  );

  for (const engine of engines) {
    for (const other of engines) {
      if (engine === other) continue;
      const missing = [...posesByEngine.get(other)].filter((pose) => !posesByEngine.get(engine).has(pose));
      assert.deepEqual(
        missing,
        [],
        `engine ${engine} is missing baselines that ${other} has: ${missing.join(', ')}. `
        + 'Record them with BROWSERS=<engine> UPDATE=<pose>.',
      );
    }
  }

  // The suite must actually compare every engine it has images for, rather than
  // listing engines by hand.
  const browserTest = readFileSync(`${root}tests/browser.test.mjs`, 'utf8');
  assert.doesNotMatch(
    browserTest,
    /const GOLDEN_ENGINES = new Set\(\s*\['/u,
    'GOLDEN_ENGINES must be derived from tests/golden, not hard-coded',
  );
});
