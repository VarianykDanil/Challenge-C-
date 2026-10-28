// Which built files the service worker saves on the phone at install (build/precache.ts). Run by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPrecache, type BuiltChunk } from './precache.ts';

const chunk = (fileName: string, o: Partial<BuiltChunk> = {}): BuiltChunk => ({
  fileName, isEntry: false, facadeModuleId: null, moduleIds: o.facadeModuleId ? [o.facadeModuleId] : [], imports: [], dynamicImports: [], ...o,
});

const SRC = '/app/client/src';
const chunks: BuiltChunk[] = [
  chunk('assets/index-A.js', { isEntry: true, imports: ['assets/react-B.js'], dynamicImports: ['assets/Dashboard-C.js', 'assets/Gauges-D.js', 'assets/Finance-E.js'] }),
  chunk('assets/react-B.js'),
  chunk('assets/Dashboard-C.js', { facadeModuleId: `${SRC}/pages/Dashboard.tsx`, imports: ['assets/Card-F.js'], dynamicImports: ['assets/lazy-G.js'] }),
  chunk('assets/Card-F.js'),
  chunk('assets/lazy-G.js', { facadeModuleId: `${SRC}/components/charts/TrendChart.tsx`, imports: ['assets/recharts-H.js'] }),
  chunk('assets/recharts-H.js'),
  chunk('assets/Gauges-D.js', { facadeModuleId: `${SRC}/pages/Gauges.tsx`, imports: ['assets/Card-F.js'] }),
  chunk('assets/Finance-E.js', { facadeModuleId: `${SRC}/pages/Finance.tsx`, dynamicImports: ['assets/invoicePdf-I.js'] }),
  // PDF downloads: loaded when someone taps "Download PDF", cached then, not saved up front
  chunk('assets/invoicePdf-I.js', { facadeModuleId: `${SRC}/features/invoices/invoicePdf.ts`, imports: ['assets/engine-J.js'] }),
  chunk('assets/engine-J.js', { facadeModuleId: `${SRC}/lib/pdf/engine.ts`, dynamicImports: ['assets/html2canvas-K.js'] }),
  chunk('assets/html2canvas-K.js', { facadeModuleId: '/app/node_modules/html2canvas/dist/html2canvas.esm.js' }),
  // never reached from the entry at all
  chunk('assets/orphan-L.js'),
];

const assets = [
  'assets/index-M.css',
  'assets/inter-latin-wght-normal-N.woff2',
  'assets/inter-latin-ext-wght-normal-O.woff2',
  'assets/inter-cyrillic-wght-normal-P.woff2',
  'assets/inter-greek-wght-normal-Q.woff2',
];
const publicFiles = ['index.html', 'favicon.svg', 'logo.svg', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png', 'brand/mark.svg', 'cod-pack/five-steps.png', 'sw.js'];

test('every page chunk and everything it needs is saved, so any page opens with no signal', () => {
  const { precache } = planPrecache({ chunks, assets, publicFiles });
  for (const f of ['assets/index-A.js', 'assets/react-B.js', 'assets/Dashboard-C.js', 'assets/Card-F.js', 'assets/lazy-G.js', 'assets/recharts-H.js', 'assets/Gauges-D.js', 'assets/Finance-E.js']) {
    assert.ok(precache.includes(`/${f}`), f);
  }
});

test('the page itself, the stylesheet, the Latin fonts, the manifest and the icons are saved', () => {
  const { precache } = planPrecache({ chunks, assets, publicFiles });
  for (const u of ['/index.html', '/assets/index-M.css', '/assets/inter-latin-wght-normal-N.woff2', '/assets/inter-latin-ext-wght-normal-O.woff2', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png', '/favicon.svg', '/logo.svg', '/brand/mark.svg']) {
    assert.ok(precache.includes(u), u);
  }
});

test('PDF libraries, other alphabets, lesson pictures and the worker itself are left to load when needed', () => {
  const { precache, onDemand } = planPrecache({ chunks, assets, publicFiles });
  for (const u of ['/assets/invoicePdf-I.js', '/assets/engine-J.js', '/assets/html2canvas-K.js', '/assets/inter-cyrillic-wght-normal-P.woff2', '/assets/inter-greek-wght-normal-Q.woff2', '/cod-pack/five-steps.png', '/sw.js', '/assets/orphan-L.js']) {
    assert.ok(!precache.includes(u), u);
  }
  assert.ok(onDemand.includes('/assets/invoicePdf-I.js'));
  assert.ok(onDemand.includes('/assets/engine-J.js'));
});

test('the list has no duplicates and a stable order (the release version is a hash of it)', () => {
  const a = planPrecache({ chunks, assets, publicFiles }).precache;
  const b = planPrecache({ chunks: [...chunks].reverse(), assets: [...assets].reverse(), publicFiles: [...publicFiles].reverse() }).precache;
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});

test('a chunk the app also imports directly is saved even if a PDF module imports it too', () => {
  const shared = [
    chunk('assets/index-A.js', { isEntry: true, imports: ['assets/csv-Z.js'], dynamicImports: ['assets/engine-J.js'] }),
    chunk('assets/engine-J.js', { facadeModuleId: `${SRC}/lib/pdf/engine.ts`, imports: ['assets/csv-Z.js'] }),
    chunk('assets/csv-Z.js', { facadeModuleId: `${SRC}/lib/csv.ts` }),
  ];
  const { precache } = planPrecache({ chunks: shared, assets: [], publicFiles: ['index.html'] });
  assert.ok(precache.includes('/assets/csv-Z.js'));
  assert.ok(!precache.includes('/assets/engine-J.js'));
});

test('a PDF chunk Rollup merged with its libraries (no facade module) is still left to load when used', () => {
  const merged = [
    chunk('assets/index-A.js', { isEntry: true, dynamicImports: ['assets/pdf-index-B.js'] }),
    chunk('assets/pdf-index-B.js', { facadeModuleId: `${SRC}/lib/pdf/index.ts`, dynamicImports: ['assets/engine-C.js'] }),
    chunk('assets/engine-C.js', { moduleIds: ['/app/node_modules/jspdf/dist/jspdf.es.min.js', '/app/node_modules/pako/dist/pako.esm.mjs', `${SRC}/lib/pdf/engine.ts`] }),
  ];
  const { precache, onDemand } = planPrecache({ chunks: merged, assets: [], publicFiles: ['index.html'] });
  assert.ok(precache.includes('/assets/pdf-index-B.js'), 'the small loader is saved (pages import it)');
  assert.ok(!precache.includes('/assets/engine-C.js'));
  assert.deepEqual(onDemand, ['/assets/engine-C.js']);
});

test('a library loaded lazily for a page (not a PDF tool) is saved', () => {
  const lib = [
    chunk('assets/index-A.js', { isEntry: true, dynamicImports: ['assets/lib-B.js'] }),
    chunk('assets/lib-B.js', { facadeModuleId: '/app/node_modules/some-lib/index.js' }),
  ];
  assert.ok(planPrecache({ chunks: lib, assets: [], publicFiles: [] }).precache.includes('/assets/lib-B.js'));
});
