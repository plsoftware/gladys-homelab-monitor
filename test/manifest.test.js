// The limits Gladys enforces when installing a manifest (refused with
// "The integration manifest is invalid" otherwise), checked before a release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const lengths = (text) => Object.entries(text ?? {});

test('integration description: 10-100 characters per language', () => {
  for (const [lang, s] of lengths(manifest.description)) {
    assert.ok(s.length >= 10 && s.length <= 100, `description.${lang} is ${s.length}`);
  }
});

test('widget and scene trigger descriptions: 1-100 characters', () => {
  for (const [i, w] of manifest.widgets.entries()) {
    for (const [lang, s] of lengths(w.description)) {
      assert.ok(s.length >= 1 && s.length <= 100, `widgets[${i}].description.${lang} is ${s.length}`);
    }
  }
  for (const [i, t] of manifest.scene_triggers.entries()) {
    for (const [lang, s] of lengths(t.description)) {
      assert.ok(s.length <= 100, `scene_triggers[${i}].description.${lang} is ${s.length}`);
    }
  }
});

test('manifest version and image tag follow package.json', () => {
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.docker_image.endsWith(`:${pkg.version}`));
});
