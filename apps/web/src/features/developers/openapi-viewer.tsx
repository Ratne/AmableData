import { Input } from '@amable/ui/ui/input';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Lock, Search } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { apiFetch } from '../../lib/api';

/*
 * Self-contained OpenAPI 3.1 reference (no third-party script, CSP friendly):
 * tag groups in a sidebar, operations with permission, parameters, request
 * body and responses; schemas rendered as an expandable tree with $ref resolution.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface Operation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly op: JsonObject;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const METHOD_CLASS: Record<string, string> = {
  get: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  post: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  put: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  patch: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  delete: 'bg-red-500/15 text-red-700 dark:text-red-300',
};

function isObj(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: Json | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function anchor(method: string, path: string): string {
  return `op-${method}-${path.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

function resolve(doc: JsonObject, schema: Json | undefined): { schema: JsonObject; name: string | null } {
  if (!isObj(schema)) return { schema: {}, name: null };
  const ref = str(schema['$ref']);
  if (ref === null) return { schema, name: null };
  const name = ref.split('/').pop() ?? ref;
  const components = isObj(doc['components']) ? doc['components'] : {};
  const schemas = isObj(components['schemas']) ? components['schemas'] : {};
  const target = schemas[name];
  return { schema: isObj(target) ? target : {}, name };
}

function typeLabel(doc: JsonObject, raw: Json | undefined): string {
  const { schema, name } = resolve(doc, raw);
  if (name !== null) return name;
  const type = schema['type'];
  if (Array.isArray(type)) return type.filter((x) => typeof x === 'string').join(' | ');
  if (type === 'array') return `${typeLabel(doc, schema['items'])}[]`;
  if (typeof type === 'string') return type;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = schema[key];
    if (Array.isArray(list)) return list.map((s) => typeLabel(doc, s)).join(key === 'allOf' ? ' & ' : ' | ');
  }
  if (schema['enum'] !== undefined) return 'enum';
  return isObj(schema['properties']) ? 'object' : 'any';
}

function SchemaTree({ doc, schema: raw, depth = 0, seen = [] }: { doc: JsonObject; schema: Json | undefined; depth?: number; seen?: readonly string[] }) {
  const { t } = useI18n();
  const { schema, name } = resolve(doc, raw);
  if (name !== null && seen.includes(name)) return <span className="text-xs italic">↺ {name}</span>;
  const nextSeen = name === null ? seen : [...seen, name];
  const items = schema['type'] === 'array' ? schema['items'] : undefined;
  if (items !== undefined) return <SchemaTree doc={doc} schema={items} depth={depth} seen={nextSeen} />;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const list = schema[key];
    if (Array.isArray(list) && list.some((s) => isObj(resolve(doc, s).schema['properties']))) {
      return (
        <div className="grid gap-2">
          {list.map((s, i) => (
            <div key={i} className="rounded border border-dashed border-border p-2">
              <div className="mb-1 text-xs font-medium">{t('dev.docs.variant', { n: i + 1 })} · {typeLabel(doc, s)}</div>
              <SchemaTree doc={doc} schema={s} depth={depth + 1} seen={nextSeen} />
            </div>
          ))}
        </div>
      );
    }
  }
  const properties = isObj(schema['properties']) ? schema['properties'] : null;
  if (properties === null) {
    const enumValues = Array.isArray(schema['enum']) ? schema['enum'] : null;
    return (
      <span className="font-mono text-xs">
        {typeLabel(doc, raw)}
        {enumValues ? ` (${enumValues.map(String).join(' | ')})` : ''}
      </span>
    );
  }
  const required = new Set(Array.isArray(schema['required']) ? schema['required'].map(String) : []);
  return (
    <ul className="grid gap-1 border-l border-border pl-3">
      {Object.entries(properties).map(([key, value]) => {
        const resolved = resolve(doc, value);
        const nested = isObj(resolved.schema['properties']) || (resolved.schema['type'] === 'array' && isObj(resolve(doc, resolved.schema['items']).schema['properties']));
        const description = str(resolved.schema['description']) ?? (isObj(value) ? str(value['description']) : null);
        const enumValues = Array.isArray(resolved.schema['enum']) ? resolved.schema['enum'] : null;
        const head = (
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-xs font-semibold">{key}</span>
            <span className="font-mono text-xs text-sky-700 dark:text-sky-300">{typeLabel(doc, value)}</span>
            {required.has(key) ? <span className="text-[10px] uppercase text-red-600">{t('dev.docs.required')}</span> : null}
            {enumValues ? <span className="font-mono text-[11px] text-(--obsidian-dashboard-shell-text-subtle)">{enumValues.map(String).join(' | ')}</span> : null}
            {description ? <span className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{description}</span> : null}
          </span>
        );
        return (
          <li key={key}>
            {nested && depth < 5 ? (
              <details>
                <summary className="cursor-pointer list-none">
                  <span className="inline-flex items-center gap-1">
                    <ChevronRight className="size-3" />
                    {head}
                  </span>
                </summary>
                <div className="mt-1">
                  <SchemaTree doc={doc} schema={value} depth={depth + 1} seen={nextSeen} />
                </div>
              </details>
            ) : (
              head
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-(--obsidian-dashboard-shell-text-subtle)">{title}</h4>
      {children}
    </div>
  );
}

function OperationView({ doc, operation }: { doc: JsonObject; operation: Operation }) {
  const { t } = useI18n();
  const { op, method, path } = operation;
  const params = Array.isArray(op['parameters']) ? op['parameters'].filter(isObj) : [];
  const body = isObj(op['requestBody']) ? op['requestBody'] : null;
  const bodySchema = body && isObj(body['content']) && isObj(body['content']['application/json']) ? body['content']['application/json']['schema'] : undefined;
  const responses = isObj(op['responses']) ? op['responses'] : {};
  const permission = str(op['x-amable-permission']);
  return (
    <article id={anchor(method, path)} className="grid scroll-mt-4 gap-3 rounded-xl border border-border p-4" data-testid="api-operation">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded px-2 py-0.5 font-mono text-xs font-bold uppercase ${METHOD_CLASS[method] ?? ''}`}>{method}</span>
          <code className="font-mono text-sm">{path}</code>
          {permission ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-[11px]" title="x-amable-permission">
              <Lock className="size-3" />
              {permission}
            </span>
          ) : null}
        </div>
        {str(op['summary']) ? <h3 className="text-base font-semibold">{str(op['summary'])}</h3> : null}
        {str(op['description']) ? <p className="text-sm text-(--obsidian-dashboard-shell-text-subtle)">{str(op['description'])}</p> : null}
      </header>
      {params.length > 0 ? (
        <Section title={t('dev.docs.parameters')}>
          <ul className="grid gap-1">
            {params.map((p) => (
              <li key={`${String(p['in'])}:${String(p['name'])}`} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-mono font-semibold">{String(p['name'])}</span>
                <span className="text-(--obsidian-dashboard-shell-text-subtle)">{String(p['in'])}</span>
                <span className="font-mono text-sky-700 dark:text-sky-300">{typeLabel(doc, p['schema'])}</span>
                {p['required'] === true ? <span className="text-[10px] uppercase text-red-600">{t('dev.docs.required')}</span> : null}
                {str(p['description']) ?? (isObj(p['schema']) ? str(p['schema']['description']) : null)}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {bodySchema !== undefined ? (
        <Section title={t('dev.docs.body')}>
          <SchemaTree doc={doc} schema={bodySchema} />
        </Section>
      ) : null}
      <Section title={t('dev.docs.responses')}>
        <ul className="grid gap-2">
          {Object.entries(responses).map(([status, value]) => {
            const response = isObj(value) ? value : {};
            const content = isObj(response['content']) ? response['content'] : {};
            const json = isObj(content['application/json']) ? content['application/json'] : null;
            const ok = status.startsWith('2');
            return (
              <li key={status} className="text-xs">
                <details open={ok}>
                  <summary className="cursor-pointer">
                    <span className={`font-mono font-semibold ${ok ? 'text-emerald-600' : 'text-amber-600'}`}>{status}</span> {str(response['description'])}
                  </summary>
                  {json && ok ? (
                    <div className="mt-1">
                      <SchemaTree doc={doc} schema={json['schema']} />
                    </div>
                  ) : null}
                </details>
              </li>
            );
          })}
        </ul>
      </Section>
    </article>
  );
}

/** Full API reference rendered from `/api/v2/openapi/all.json`. */
export function ApiReference() {
  const { t } = useI18n();
  const spec = useQuery({
    queryKey: ['openapi', 'all'],
    queryFn: () => apiFetch<JsonObject>('/api/v2/openapi/all.json'),
    staleTime: 5 * 60_000,
  });
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const doc = spec.data;

  const { operations, groups } = useMemo(() => {
    const ops: Operation[] = [];
    const paths = doc && isObj(doc['paths']) ? doc['paths'] : {};
    for (const [path, item] of Object.entries(paths)) {
      if (!isObj(item)) continue;
      for (const method of METHODS) {
        const op = item[method];
        if (isObj(op)) ops.push({ id: `${method} ${path}`, method, path, op });
      }
    }
    const tagGroups = doc && Array.isArray(doc['x-tagGroups']) ? doc['x-tagGroups'].filter(isObj) : [];
    return {
      operations: ops,
      groups: tagGroups.map((g) => ({ name: String(g['name']), tags: Array.isArray(g['tags']) ? g['tags'].map(String) : [] })),
    };
  }, [doc]);

  const tagOf = (op: Operation) => (Array.isArray(op.op['tags']) ? String(op.op['tags'][0] ?? '') : '');
  const needle = query.trim().toLowerCase();
  const filtered = operations.filter((op) => {
    if (needle !== '') {
      const hay = `${op.method} ${op.path} ${str(op.op['summary']) ?? ''} ${str(op.op['x-amable-permission']) ?? ''}`.toLowerCase();
      return hay.includes(needle);
    }
    return activeTag === null || tagOf(op) === activeTag;
  });
  const counts = new Map<string, number>();
  for (const op of operations) counts.set(tagOf(op), (counts.get(tagOf(op)) ?? 0) + 1);

  if (spec.isPending) return <p className="p-6 text-sm">{t('common.loading')}</p>;
  if (doc === undefined) return <p className="p-6 text-sm">{t('common.error')}</p>;
  const info = isObj(doc['info']) ? doc['info'] : {};

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="grid content-start gap-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2.5 size-4 opacity-60" />
          <Input className="pl-8" placeholder={t('dev.docs.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button type="button" className={`text-left text-sm ${activeTag === null && needle === '' ? 'font-semibold' : ''}`} onClick={() => setActiveTag(null)}>
          {t('dev.docs.overview')} · {operations.length}
        </button>
        <nav className="grid gap-3" aria-label={t('dev.docs.title')}>
          {groups.map((group) => (
            <div key={group.name} className="grid gap-1">
              <div className="text-xs font-semibold uppercase tracking-wide text-(--obsidian-dashboard-shell-text-subtle)">{group.name}</div>
              {group.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setActiveTag(tag);
                  }}
                  className={`flex justify-between rounded px-2 py-1 text-left text-sm hover:bg-accent ${activeTag === tag && needle === '' ? 'bg-accent font-medium' : ''}`}
                >
                  <span className="truncate">{tag}</span>
                  <span className="text-xs opacity-60">{counts.get(tag) ?? 0}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="grid min-w-0 content-start gap-4">
        {activeTag === null && needle === '' ? (
          <section className="grid gap-3 rounded-xl border border-border p-4 text-sm">
            <h2 className="text-lg font-semibold">{str(info['title'])} <span className="text-xs font-normal opacity-70">v{str(info['version'])}</span></h2>
            <p>{str(info['description'])}</p>
            <pre className="overflow-x-auto rounded-lg border border-border p-3 font-mono text-xs">{`curl -H "Authorization: Bearer amb_live_…" \\\n  ${typeof window === 'undefined' ? '' : window.location.origin}/api/v2/t/<workspace>/contacts?limit=10`}</pre>
            <p className="text-xs">
              {t('dev.docs.download')}{' '}
              <a className="underline" href="/api/v2/openapi/all.json" target="_blank" rel="noreferrer">
                openapi/all.json
              </a>
            </p>
          </section>
        ) : null}
        {filtered.length === 0 ? <p className="text-sm">{t('dev.docs.noResults')}</p> : null}
        {(activeTag !== null || needle !== '' ? filtered : filtered.slice(0, 25)).map((op) => (
          <OperationView key={op.id} doc={doc} operation={op} />
        ))}
        {activeTag === null && needle === '' && filtered.length > 25 ? (
          <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{t('dev.docs.more', { count: filtered.length - 25 })}</p>
        ) : null}
      </main>
    </div>
  );
}
