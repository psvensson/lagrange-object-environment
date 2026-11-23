import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {cssVarsForResolvedTokens} from '../src/browser-renderer/dom-theme.js';

const load = name => JSON.parse(readFileSync(new URL(`./fixtures/theme/${name}-tokens.json`, import.meta.url), 'utf8'));

test('DOM T4 consumes every resolved token, without an alternate code palette', () => {
  const stock = load('stock');
  const derived = load('derived');
  for (const tokens of [stock, derived]) {
    const vars = cssVarsForResolvedTokens(tokens);
    assert.equal(Object.keys(vars).length, 15);
    assert.deepEqual(Object.keys(vars).sort(), tokens.map(t => `--lagrange-${t.path.replaceAll('.', '-')}`).sort());
    assert.ok(Object.isFrozen(vars));
    for (const token of tokens) {
      const css = vars[`--lagrange-${token.path.replaceAll('.', '-')}`];
      assert.equal(css, token.type === 'fontFamily' || token.type === 'color'
        ? token.value : `${token.value}px`);
    }
  }
  assert.equal(cssVarsForResolvedTokens(stock)['--lagrange-surface-base'], '#e6e6e2');
  assert.equal(cssVarsForResolvedTokens(derived)['--lagrange-surface-base'], '#121922');
});

test('DOM T4 refuses missing, malformed or injection-capable values before styling', () => {
  const base = load('stock');
  const corruptions = [
    base.slice(0, -1),
    [...base, base[0]],
    base.map(t => t.path === 'accent' ? {...t, type: 'fontFamily'} : t),
    base.map(t => t.path === 'accent' ? {...t, value: 'red; background: url(https://invalid)'} : t),
    base.map(t => t.path === 'accent' ? {...t, value: '#AABBCC'} : t),
    base.map(t => t.path === 'radius.normal' ? {...t, value: -1} : t),
    base.map(t => t.path === 'typography.ui.size' ? {...t, value: 0} : t),
    base.map(t => t.path === 'typography.ui.family' ? {...t, value: 'Arial; color: red'} : t),
    base.map(t => t.path === 'accent' ? {...t, path: 'css.background'} : t),
    base.map(t => t.path === 'accent' ? {...t, extra: 'extra'} : t),
  ];
  for (const tokens of corruptions) assert.throws(() => cssVarsForResolvedTokens(tokens), TypeError);
  for (const input of [null, undefined, {}, 'theme']) assert.throws(() => cssVarsForResolvedTokens(input), TypeError);
});
