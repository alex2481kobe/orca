import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ setAttribute() {}, insertAdjacentElement() {} }),
  querySelector: () => null,
  addEventListener() {},
};
globalThis.window = {
  location: {
    hostname: 'localhost',
    protocol: 'http:',
    origin: 'http://localhost:3000',
    port: '3000',
  },
};

const { fallbackUrlForAccessMode, preferredPhoneUrl } = await import('../public/ui/access-mode.js');

test('tailnet phone URL selection does not fall back to localhost targets', () => {
  const localOnlyTailnetTarget = {
    favorite: true,
    mode: 'tailnet-http',
    localUrl: 'http://127.0.0.1:4173/',
  };

  assert.equal(fallbackUrlForAccessMode(localOnlyTailnetTarget, 'tailnet-http'), '');
  assert.equal(
    preferredPhoneUrl(
      [localOnlyTailnetTarget],
      { preferredMode: 'tailnet-http' },
      { servedUrl: 'http://mac.tailnet.ts.net' },
    ),
    'http://mac.tailnet.ts.net',
  );
});
