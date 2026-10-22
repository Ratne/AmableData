#!/usr/bin/env node
/**
 * Builds a Marketplace app into the single ES module the CRM deploys into the
 * workspace's own Cloudflare account: `src/index.ts`, with the text files of
 * `public/` inlined in place of `src/assets.ts`, written to `dist/worker.mjs`
 * next to its SHA-256 (`dist/worker.mjs.sha256`).
 *
 *   node scripts/bundle-app.mjs examples/apps/<id>
 *
 * Run the app's `build:screens` first. `public/icon.png` is the catalog icon,
 * not a served file.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, relative, resolve, sep } from 'node:path';

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

export async function bundleApp(dir) {
  const { build } = createRequire(join(dir, 'package.json'))('esbuild');
  const publicDir = join(dir, 'public');
  const assets = {};
  for (const name of readdirSync(publicDir, { recursive: true }).map(String).sort()) {
    const file = join(publicDir, name);
    if (statSync(file).isDirectory()) continue;
    const type = TYPES[extname(name)];
    if (type === undefined) continue;
    assets[`/${name.split(sep).join('/')}`] = { type, body: readFileSync(file, 'utf8') };
  }

  const assetsModule = join(dir, 'src', 'assets.ts');
  const result = await build({
    absWorkingDir: dir,
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    write: false,
    outfile: 'dist/worker.mjs',
    logLevel: 'warning',
    plugins: [
      {
        name: 'inline-assets',
        setup(builder) {
          builder.onLoad({ filter: /[\\/]src[\\/]assets\.ts$/ }, (args) =>
            args.path === assetsModule ? { contents: `export const assets = ${JSON.stringify(assets)};`, loader: 'js' } : undefined,
          );
        },
      },
    ],
  });
  const code = result.outputFiles[0].contents;
  const sha256 = createHash('sha256').update(code).digest('hex');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  const bundle = join(dir, 'dist', 'worker.mjs');
  writeFileSync(bundle, code);
  writeFileSync(`${bundle}.sha256`, `${sha256}  worker.mjs\n`);
  return { bundle, sha256, bytes: code.byteLength, assets: Object.keys(assets) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = resolve(process.argv[2] ?? '.');
  const out = await bundleApp(dir);
  console.log(`${relative(process.cwd(), out.bundle)}  ${out.bytes} bytes  sha256 ${out.sha256}`);
  if (out.assets.length > 0) console.log(`inlined: ${out.assets.join(', ')}`);
}
