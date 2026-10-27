// Which built files the offline service worker saves on the phone when it installs (the "precache"). Pure, so it can
// be tested in Node; build/serviceWorkerPlugin.ts feeds it Vite's output.
//
// Saved up front: the entry and every chunk it reaches through static or dynamic imports (every page, the Log gauges
// form, the charts), the stylesheet, the Latin subsets of Inter, index.html, the manifest and the icons. So any page
// opens with no signal once the app has been opened online.
// Left to load when needed (and then kept by the runtime cache): the PDF tools (only used to download a PDF), font
// subsets for other alphabets, lesson pictures, and anything nothing imports.

export interface BuiltChunk {
  fileName: string;
  isEntry: boolean;
  /** The module the chunk was made for (a page, a lazily loaded component), or null for a shared chunk. */
  facadeModuleId: string | null;
  /** Every module bundled into the chunk. */
  moduleIds: string[];
  imports: string[];
  dynamicImports: string[];
}

export interface PrecacheInput {
  chunks: BuiltChunk[];
  /** Other files Vite emitted (CSS, fonts, images), relative to the output folder. */
  assets: string[];
  /** Files copied from client/public plus index.html, relative to the output folder. */
  publicFiles: string[];
}

export interface PrecachePlan {
  /** URLs to save at install, sorted. */
  precache: string[];
  /** Chunks reachable only through a PDF download (or a library loaded by one): fetched when first used. */
  onDemand: string[];
}

/**
 * A dynamically imported chunk holding one of these is loaded only when used: the PDF downloads, the PDF engine and
 * the libraries it loads. Rollup may merge the engine with its libraries into a chunk with no single facade module,
 * so every module of the chunk is checked.
 */
const ON_DEMAND = [
  /\/node_modules\/(jspdf|jspdf-autotable|html2canvas|canvg|dompurify)\//,
  /\/src\/lib\/pdf\/engine\.tsx?$/,
  /Pdf\.tsx?$/,
  /\/venueReport\.tsx?$/,
];

const onDemandChunk = (c: BuiltChunk) =>
  [c.facadeModuleId, ...c.moduleIds].some((id) => !!id && ON_DEMAND.some((re) => re.test(id.replace(/\\/g, '/'))));

/** Inter's Latin and Latin Extended subsets cover UK English and names with accents; other alphabets load if used. */
const PRECACHE_FONT = /inter-latin(-ext)?-[a-z]+-normal-[^/]*\.woff2$/;

/** Public folders that are saved: icons and the brand marks. Lesson pictures (cod-pack) are kept once viewed. */
const PRECACHE_PUBLIC = /^(index\.html|manifest\.webmanifest|favicon\.svg|logo\.svg|icons\/[^/]+\.png|brand\/[^/]+\.svg)$/;

export function planPrecache({ chunks, assets, publicFiles }: PrecacheInput): PrecachePlan {
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const keep = new Set<string>();
  const skipped = new Set<string>();
  const queue = chunks.filter((c) => c.isEntry).map((c) => c.fileName);
  while (queue.length) {
    const name = queue.shift()!;
    if (keep.has(name)) continue;
    const c = byName.get(name);
    if (!c) continue;
    keep.add(name);
    for (const i of c.imports) queue.push(i);
    for (const d of c.dynamicImports) {
      const target = byName.get(d);
      if (target && onDemandChunk(target)) skipped.add(d);
      else queue.push(d);
    }
  }
  const urls = new Set<string>();
  for (const name of keep) urls.add(`/${name}`);
  for (const a of assets) {
    if (a.endsWith('.css') || PRECACHE_FONT.test(a)) urls.add(`/${a}`);
  }
  for (const f of publicFiles) if (PRECACHE_PUBLIC.test(f)) urls.add(`/${f}`);
  const onDemand = [...skipped].filter((s) => !keep.has(s)).map((s) => `/${s}`);
  // what a skipped chunk pulls in statically is on demand too, unless something kept needs it
  const more = [...skipped];
  while (more.length) {
    const c = byName.get(more.shift()!);
    if (!c) continue;
    for (const i of [...c.imports, ...c.dynamicImports]) {
      if (keep.has(i) || onDemand.includes(`/${i}`)) continue;
      onDemand.push(`/${i}`);
      more.push(i);
    }
  }
  return { precache: [...urls].sort(), onDemand: onDemand.sort() };
}
