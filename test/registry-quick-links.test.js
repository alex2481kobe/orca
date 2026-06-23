import assert from 'node:assert/strict';
import test from 'node:test';
import {
  effectiveQuickLinkUrl,
  normalizeQuickLink,
} from '../src/registry-quick-links.js';

test('quick link URL preference keeps auto local but supports explicit tailnet checks', () => {
  const link = normalizeQuickLink({
    label: 'Example App',
    url: 'http://127.0.0.1:5173',
    localUrl: 'http://127.0.0.1:5173',
    tailnetHttpUrl: 'http://orca.example.ts.net:5173',
    httpsServeUrl: 'https://orca.example.ts.net',
    healthPath: '/readyz',
  });

  assert.equal(effectiveQuickLinkUrl(link, { prefer: 'auto' }), 'http://127.0.0.1:5173/');
  assert.equal(effectiveQuickLinkUrl(link, { prefer: 'local' }), 'http://127.0.0.1:5173/');
  assert.equal(effectiveQuickLinkUrl(link, { prefer: 'tailnet' }), 'http://orca.example.ts.net:5173/');
  assert.equal(effectiveQuickLinkUrl(link, { prefer: 'https' }), 'https://orca.example.ts.net/');
});

test('quick links can use a tailnet URL as the primary URL when local is unknown', () => {
  const link = normalizeQuickLink({
    label: 'Remote Preview',
    tailnetHttpUrl: 'http://orca.example.ts.net:5173',
    kind: 'vite',
  });

  assert.equal(link.url, 'http://orca.example.ts.net:5173/');
  assert.equal(link.port, 5173);
  assert.equal(effectiveQuickLinkUrl(link, { prefer: 'auto' }), 'http://orca.example.ts.net:5173/');
  assert.equal(effectiveQuickLinkUrl(link, { prefer: 'tailnet' }), 'http://orca.example.ts.net:5173/');
});
