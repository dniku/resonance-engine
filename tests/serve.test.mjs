// `serve.py` is the documented way to run this over http, and its
// HOST/PASEO_PORT handling is the contract a Paseo daemon relies on when it
// allocates a port itself. That resolution logic is pure, so it is cheap to pin
// — and it was previously untested despite being load-bearing for deployment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;

/** Ask the real module what address a given environment resolves to. */
function resolve(environ) {
  const python = process.env.PYTHON ?? 'python3';
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(root)})
import serve
try:
    print(json.dumps(serve.listen_target(${JSON.stringify(environ)})))
except serve.ConfigError as error:
    print(json.dumps({"configError": str(error)}))
`;
  const run = spawnSync(python, ['-c', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, `serve.py failed to import: ${run.stderr}`);
  return JSON.parse(run.stdout.trim());
}

test('with no hints it binds loopback on the documented default port', () => {
  assert.deepEqual(resolve({}), ['127.0.0.1', 8000]);
});

test("Paseo's HOST/PASEO_PORT take precedence, so its proxy can reach the socket", () => {
  assert.deepEqual(resolve({ HOST: '0.0.0.0', PASEO_PORT: '43110' }), ['0.0.0.0', 43110]);
});

test('PORT is the manual override and is respected without HOST', () => {
  assert.deepEqual(resolve({ PORT: '8123' }), ['127.0.0.1', 8123]);
});

test('PASEO_PORT wins over PORT when both are present', () => {
  // The daemon allocates the port; a stale PORT in the shell must not win.
  assert.deepEqual(resolve({ PORT: '8123', PASEO_PORT: '43110' }), ['127.0.0.1', 43110]);
});

test('port 0 is accepted so the OS may assign one', () => {
  assert.deepEqual(resolve({ PORT: '0' }), ['127.0.0.1', 0]);
});

test('a port that cannot describe a socket is a clear config error, not a traceback', () => {
  for (const bad of ['not-a-port', '65536', '-1']) {
    const result = resolve({ PORT: bad });
    assert.match(result.configError, /port/i, `${bad} produced ${JSON.stringify(result)}`);
  }
});

test('the single file is served with a type a browser will execute', () => {
  // The whole reason serve.py exists beside `python3 -m http.server`: a .js or
  // .css file served as octet-stream is a blank page with an opaque error.
  const types = spawnSync(process.env.PYTHON ?? 'python3', ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(root)})
import serve
m = serve.Handler.extensions_map
print(json.dumps({k: m[k] for k in ('.js', '.mjs', '.css', '.html')}))
`], { encoding: 'utf8' });
  assert.equal(types.status, 0, types.stderr);
  const map = JSON.parse(types.stdout);
  assert.equal(map['.js'], 'text/javascript');
  assert.equal(map['.mjs'], 'text/javascript');
  assert.equal(map['.css'], 'text/css');
  assert.equal(map['.html'], 'text/html');
});
