// Builds dist/sw.js, the offline service worker, after the app itself is built.
//
// 1. From Vite's output it works out which files to save on the phone (build/precache.ts): every page chunk, the
//    stylesheet, the Latin fonts, index.html, the manifest and the icons.
// 2. It compiles sw/sw.ts on its own (one classic script, no imports left) and puts the release version and that list
//    in front of it. The version is a hash of the list, index.html and the worker's code, so every release that
//    changes anything gives phones a new sw.js, and they offer to reload.
// 3. It adds a preload for the Latin font to index.html, so text does not change face after the first paint.
// Only runs for `vite build`; `vite` (development) has no service worker.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build, type Plugin } from 'vite';
import { planPrecache, type BuiltChunk } from './precache.ts';

function filesUnder(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

const kB = (n: number) => `${(n / 1000).toFixed(1)} kB`;

export function serviceWorkerPlugin(opts: { swEntry: string }): Plugin {
  let outDir = '';
  let chunks: BuiltChunk[] = [];
  let assets: string[] = [];
  return {
    name: 'linear-hub-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const font = Object.keys(ctx.bundle ?? {}).find((f) => /inter-latin-wght-normal-[^/]*\.woff2$/.test(f));
        if (!font) return;
        return [{ tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `/${font}`, crossorigin: '' }, injectTo: 'head' }];
      },
    },
    generateBundle(_options, bundle) {
      chunks = [];
      assets = [];
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') {
          chunks.push({ fileName: item.fileName, isEntry: item.isEntry, facadeModuleId: item.facadeModuleId, moduleIds: item.moduleIds, imports: item.imports, dynamicImports: item.dynamicImports });
        } else {
          assets.push(item.fileName);
        }
      }
    },
    async closeBundle() {
      if (!chunks.length) return;
      const publicFiles = filesUnder(outDir).filter((f) => !f.startsWith('assets/'));
      const plan = planPrecache({ chunks, assets, publicFiles });
      const indexHtml = readFileSync(path.join(outDir, 'index.html'), 'utf8');
      const result = await build({
        configFile: false,
        logLevel: 'warn',
        publicDir: false,
        build: {
          write: false,
          emptyOutDir: false,
          minify: true,
          target: 'es2020',
          lib: { entry: opts.swEntry, formats: ['iife'], name: 'LinearHubServiceWorker', fileName: () => 'sw.js' },
        },
      });
      const output = (Array.isArray(result) ? result[0] : result) as { output: Array<{ type: string; code?: string }> };
      const code = output.output.find((o) => o.type === 'chunk')?.code;
      if (!code) throw new Error('The service worker did not build');
      // The release version names the cache: a hash of the file list, the page and the worker's own built code (so a
      // change anywhere in sw/ gives phones a new worker and a fresh cache).
      const version = createHash('sha256').update(JSON.stringify(plan.precache)).update(indexHtml).update(code).digest('hex').slice(0, 12);
      const header = `self.__LM_SW__=${JSON.stringify({ version, precache: plan.precache })};\n`;
      writeFileSync(path.join(outDir, 'sw.js'), header + code);

      const bytes = plan.precache.reduce((sum, url) => {
        try {
          return sum + statSync(path.join(outDir, url === '/' ? 'index.html' : url.slice(1))).size;
        } catch {
          return sum;
        }
      }, 0);
      console.log(`\nService worker ${version}: ${plan.precache.length} files saved for offline use (${kB(bytes)} before compression); ${plan.onDemand.length} PDF files load when first used.`);
    },
  };
}
