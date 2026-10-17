import { parseAppManifest } from '@amable/core/apps';
import { readFileSync } from 'node:fs';
import { formatResults, passed, runConformance } from './conformance';
import { createApp } from './create';
import { generateKeys, publicJwks, pruneKeys, readKeys, rotateKeys, secretValue } from './keys';

const HELP = `amable-app — tools for AmableData app developers

  create <dir> [--id my-app] [--name "My App"] [--base-url https://…]
                                 new app from the Cloudflare Worker template
  keys generate                  first signing key in .amable/keys.json
  keys rotate                    new active key, previous one stays published
  keys prune                     drop the previous key (a day after rotating)
  keys jwks                      public JWKS (what jwks_url serves)
  keys secret                    value of the APP_KEYS Worker secret
  validate [manifest.json]       check a manifest against the schema
  test [--manifest manifest.json] [--local] [--secret whsec_…] [--installation ai_…]
                                 conformance suite (what the catalog CI runs)
`;

function flags(args: readonly string[]): { positional: string[]; values: Map<string, string | true> } {
  const positional: string[] = [];
  const values = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) values.set(arg.slice(2), true);
    else {
      values.set(arg.slice(2), next);
      i += 1;
    }
  }
  return { positional, values };
}

const text = (value: string | true | undefined): string | undefined => (typeof value === 'string' ? value : undefined);

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, values } = flags(rest);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  try {
    switch (command) {
      case 'create': {
        const dir = positional[0];
        if (dir === undefined) throw new Error('usage: create-amable-app <dir>');
        const created = await createApp({ dir, appId: text(values.get('id')), name: text(values.get('name')), baseUrl: text(values.get('base-url')) });
        out(`Created ${created.appId} in ${created.dir}`);
        out('');
        out('Next steps:');
        out(`  cd ${dir} && npm install`);
        out('  npx wrangler kv namespace create INSTALLS   # put the id in wrangler.jsonc');
        out('  npx amable-app keys secret | npx wrangler secret put APP_KEYS');
        out('  npm run deploy, then set base_url in manifest.json to the Worker URL');
        out('  Install it in a workspace: Settings → Apps → Install from URL → <base_url>/manifest.json');
        return 0;
      }
      case 'keys': {
        const dir = process.cwd();
        const action = positional[0] ?? 'jwks';
        const file =
          action === 'generate' ? await generateKeys(dir) : action === 'rotate' ? await rotateKeys(dir) : action === 'prune' ? pruneKeys(dir) : readKeys(dir);
        if (file.keys.length === 0) throw new Error('no keys yet: run `amable-app keys generate`');
        if (action === 'secret') {
          out(secretValue(file));
          return 0;
        }
        if (action === 'rotate') out('Rotated. Update the secret (amable-app keys secret | wrangler secret put APP_KEYS), deploy, prune in 24 h.');
        out(JSON.stringify(publicJwks(file), null, 2));
        return 0;
      }
      case 'validate': {
        const path = positional[0] ?? 'manifest.json';
        const result = parseAppManifest(JSON.parse(readFileSync(path, 'utf8')));
        if (result.ok) {
          out(`✓ ${path} is a valid manifest for ${result.manifest.id}`);
          return 0;
        }
        for (const issue of result.issues) out(`✗ ${issue.path}: ${issue.message}`);
        return 1;
      }
      case 'test': {
        const path = text(values.get('manifest')) ?? 'manifest.json';
        const results = await runConformance({
          manifest: JSON.parse(readFileSync(path, 'utf8')),
          local: values.has('local'),
          secret: text(values.get('secret')),
          installationId: text(values.get('installation')),
        });
        out(formatResults(results));
        return passed(results) ? 0 : 1;
      }
      default:
        out(HELP);
        return command === undefined || command === 'help' || command === '--help' ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
