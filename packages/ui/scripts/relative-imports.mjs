#!/usr/bin/env node
// Registry CLIs (shadcn, tiptap) write `@/…` imports. Workspace packages are
// consumed as source by apps/web, where `@/` means something else, so after
// every `add` run: `node packages/ui/scripts/relative-imports.mjs packages/<pkg>`.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: relative-imports.mjs <package-dir>');
  process.exit(1);
}
const src = join(root, 'src');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

let changed = 0;
for (const file of walk(src).filter((path) => /\.(tsx?|jsx?|scss)$/.test(path))) {
  const source = readFileSync(file, 'utf8');
  const next = source.replace(/(["'])@\/([^"']+)\1/g, (_match, quote, rest) => {
    let target = relative(dirname(file), join(src, rest));
    if (!target.startsWith('.')) target = `./${target}`;
    return `${quote}${target}${quote}`;
  });
  if (next !== source) {
    writeFileSync(file, next);
    changed += 1;
  }
}
console.log(`rewrote imports in ${String(changed)} file(s)`);
