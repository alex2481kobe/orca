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

const {
  effectiveProjectQuickLinkCheckPreference,
  effectiveProjectQuickLinkUrl,
  fallbackUrlForAccessMode,
  preferredPhoneUrl,
} = await import('../public/ui/access-mode.js');

function setLocation({ hostname, protocol, origin, port = '' }) {
  globalThis.window.location = { hostname, protocol, origin, port };
}

test('tailnet phone URL selection does not fall back to localhost targets', () => {
  setLocation({
    hostname: 'localhost',
    protocol: 'http:',
    origin: 'http://localhost:3000',
    port: '3000',
  });
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

test('remote quick-link checks use the same tailnet variant as the rendered link', () => {
  const quick = {
    url: 'http://127.0.0.1:5173/',
    localUrl: 'http://127.0.0.1:5173/',
    tailnetHttpUrl: 'http://mac.tailnet.ts.net:5173/',
    httpsServeUrl: 'https://mac.tailnet.ts.net/',
  };

  setLocation({
    hostname: 'orca.tailnet.ts.net',
    protocol: 'https:',
    origin: 'https://orca.tailnet.ts.net',
  });
  assert.equal(effectiveProjectQuickLinkUrl(quick), 'https://mac.tailnet.ts.net/');
  assert.equal(effectiveProjectQuickLinkCheckPreference(quick), 'https');

  setLocation({
    hostname: 'orca.tailnet.ts.net',
    protocol: 'http:',
    origin: 'http://orca.tailnet.ts.net',
  });
  assert.equal(effectiveProjectQuickLinkUrl(quick), 'http://mac.tailnet.ts.net:5173/');
  assert.equal(effectiveProjectQuickLinkCheckPreference(quick), 'tailnet');
});
