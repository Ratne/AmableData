#!/usr/bin/env node
/**
 * Names rule check: some third-party product names must never appear in the
 * repository (code, comments, file names, docs, commit messages). The names
 * themselves are never committed: this script only knows salted SHA-256
 * hashes of the normalized terms (`scripts/forbidden-names.sha256`) and hashes
 * every word token of the scanned text the same way.
 *
 * Extra terms in clear text can be supplied locally or in CI, never committed:
 * - `FORBIDDEN_NAMES` env var (comma-separated);
 * - `.forbidden-names.local` at the repo root (one per line; gitignored by `*.local`).
 *
 * Tokenization: camelCase / snake_case / kebab-case / punctuation boundaries,
 * lowercased; single tokens and runs of 2–3 adjacent tokens are checked, so
 * spaced, dotted or hyphenated spellings of a name are caught too.
 *
 * Usage: node scripts/check-forbidden-names.mjs [--no-history]
 *        node scripts/check-forbidden-names.mjs --hash <term>   (prints the line to add)
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SALT = 'amable-names-v1:';
const HASH_FILE = join(root, 'scripts', 'forbidden-names.sha256');
const LOCAL_FILE = join(root, '.forbidden-names.local');
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Generated or vendored files whose random-looking content only produces noise. */
const SKIPPED = [/^pnpm-lock\.yaml$/, /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|wasm|zip|gz|pdf)$/i];

export function normalize(term) {
  return term.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function hashTerm(term) {
  return createHash('sha256').update(SALT + normalize(term)).digest('hex');
}

/** Word tokens of a line, lowercased, with their column. */
export function tokenize(line) {
  const out = [];
  for (const match of line.matchAll(/[A-Za-z0-9]+/g)) {
    const word = match[0];
    // Long runs are hashes / base64: checked whole, never split.
    const parts =
      word.length > 40 ? [word] : word.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/);
    let offset = match.index;
    for (const part of parts) {
      if (part !== '') out.push({ token: part.toLowerCase(), column: offset + 1 });
      offset += part.length;
    }
  }
  return out;
}

function loadHashes() {
  const hashes = new Set();
  if (existsSync(HASH_FILE)) {
    for (const line of readFileSync(HASH_FILE, 'utf8').split('\n')) {
      const value = line.trim();
      if (/^[0-9a-f]{64}$/.test(value)) hashes.add(value);
    }
  }
  const clear = [
    ...(process.env.FORBIDDEN_NAMES ?? '').split(','),
    ...(existsSync(LOCAL_FILE) ? readFileSync(LOCAL_FILE, 'utf8').split('\n') : []),
  ];
  for (const term of clear) if (normalize(term) !== '') hashes.add(hashTerm(term));
  return hashes;
}

export function createMatcher(hashes) {
  const cache = new Map();
  const hit = (candidate) => {
    let result = cache.get(candidate);
    if (result === undefined) {
      result = hashes.has(createHash('sha256').update(SALT + candidate).digest('hex'));
      cache.set(candidate, result);
    }
    return result;
  };
  /** Columns of forbidden terms in one line. */
  return (line) => {
    const tokens = tokenize(line);
    const found = [];
    for (let i = 0; i < tokens.length; i += 1) {
      let candidate = '';
      for (let n = 0; n < 3 && i + n < tokens.length; n += 1) {
        candidate += tokens[i + n].token;
        if (candidate.length > 64) break;
        if (hit(candidate)) {
          found.push(tokens[i].column);
          break;
        }
      }
    }
    return found;
  };
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function scanFiles(match) {
  const files = [
    ...git(['ls-files', '-z']).split('\0'),
    ...git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0'),
  ].filter((f) => f !== '');
  const problems = [];
  for (const file of new Set(files)) {
    for (const column of match(file)) problems.push(`${file} (file name, column ${column})`);
    if (SKIPPED.some((re) => re.test(file))) continue;
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    const buffer = readFileSync(path);
    if (buffer.subarray(0, 8000).includes(0)) continue;
    const lines = buffer.toString('utf8').split('\n');
    lines.forEach((line, index) => {
      for (const column of match(line)) problems.push(`${file}:${index + 1}:${column}`);
    });
  }
  return { problems, count: files.length };
}

function scanHistory(match) {
  const problems = [];
  let log = '';
  try {
    log = git(['log', '--all', '--format=%H%x00%an%x00%B%x01']);
  } catch {
    return problems;
  }
  for (const entry of log.split('\x01')) {
    const [sha = '', author = '', body = ''] = entry.trim().split('\0');
    if (sha === '') continue;
    if (match(`${author}\n${body}`).length > 0) problems.push(`commit ${sha.slice(0, 12)} (message)`);
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--hash') {
    const term = args[1] ?? '';
    if (normalize(term) === '') {
      console.error('usage: check-forbidden-names.mjs --hash <term>');
      process.exit(2);
    }
    console.log(hashTerm(term));
    return;
  }
  const hashes = loadHashes();
  if (hashes.size === 0) {
    console.error('check-forbidden-names: no forbidden terms configured');
    process.exit(2);
  }
  const match = createMatcher(hashes);
  const { problems, count } = scanFiles(match);
  if (!args.includes('--no-history')) problems.push(...scanHistory(match));
  if (problems.length > 0) {
    console.error(`check-forbidden-names: ${problems.length} occurrence(s) of a forbidden product name:`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('Use the amable / amabledata brand or a neutral name instead.');
    process.exit(1);
  }
  console.log(`check-forbidden-names: OK (${count} files, ${hashes.size} terms)`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();
