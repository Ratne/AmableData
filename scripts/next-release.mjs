#!/usr/bin/env node
/**
 * Next release after a green push to main: prints the tag and writes the notes.
 *
 *   node scripts/next-release.mjs <sha> <notes-file>
 *
 * Tags are `YYYY.M.N` (UTC month, N restarts at 1 every month). Notes list the
 * `feat`, `fix` and `perf` commits since the previous release; a line starting
 * with `Before you update:` in a commit body goes to the "Before you update"
 * section. Prints nothing (no release) when the commit is already released, or
 * when the new commits are only chore, ci, docs, test, refactor, build or style,
 * or when the subject of one of them says `[skip release]`.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [sha, notesFile] = process.argv.slice(2);
if (!sha || !notesFile) {
  console.error('usage: next-release.mjs <sha> <notes-file>');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const RELEASE_TAG = /^(\d+)\.(\d+)\.(\d+)$/;

if (git('tag', '--points-at', sha).split('\n').some((tag) => RELEASE_TAG.test(tag))) process.exit(0);

const tags = git('tag', '--list').split('\n').filter((tag) => RELEASE_TAG.test(tag));
const previous = git('tag', '--merged', sha, '--list', '--sort=-v:refname')
  .split('\n')
  .find((tag) => RELEASE_TAG.test(tag));

const SEPARATOR = '\u001e';
const log = git('log', '--no-merges', '--reverse', `--format=%s%n%b${SEPARATOR}`, previous ? `${previous}..${sha}` : sha);
const commits = log
  .split(SEPARATOR)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [subject = '', ...body] = entry.split('\n');
    return { subject, body };
  });

if (commits.some(({ subject }) => subject.includes('[skip release]'))) process.exit(0);

const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/;
const QUIET = new Set(['chore', 'ci', 'docs', 'test', 'tests', 'refactor', 'build', 'style', 'revert']);
const features = [];
const fixes = [];
const beforeUpdate = [];

for (const { subject, body } of commits) {
  for (const line of body) {
    const match = /^Before you update:\s*(.+)$/i.exec(line.trim());
    if (match) beforeUpdate.push(match[1]);
  }
  const match = CONVENTIONAL.exec(subject);
  const type = match ? match[1].toLowerCase() : null;
  if (type !== null && QUIET.has(type)) continue;
  const text = match ? match[3] : subject;
  const line = `- ${text.charAt(0).toUpperCase()}${text.slice(1)}${match?.[2] ? ` (${match[2]})` : ''}`;
  (type === 'fix' || type === 'perf' ? fixes : features).push(line);
}

if (features.length === 0 && fixes.length === 0) process.exit(0);

const now = new Date();
const month = `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}`;
const last = Math.max(0, ...tags.filter((tag) => tag.startsWith(`${month}.`)).map((tag) => Number(tag.split('.')[2])));
const next = `${month}.${last + 1}`;

const sections = ['## Before you update', ''];
for (const note of beforeUpdate) sections.push(`- ${note}`);
sections.push('- Database migrations run automatically when the workers start.', '');
if (features.length > 0) sections.push(`## New in ${next}`, '', ...features, '');
if (fixes.length > 0) sections.push('### Fixes', '', ...fixes, '');
if (previous) sections.push(`**Full changelog:** ${previous}...${next}`, '');

writeFileSync(notesFile, sections.join('\n'));
console.log(next);
