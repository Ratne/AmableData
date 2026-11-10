import {
  hasPhosphor,
  icon as iconSvg,
  ICON_NAMES,
  loadPhosphor,
  loadPhosphorCatalog,
  parsePhosphor,
  PHOSPHOR_WEIGHTS,
  phosphorName,
  type PhosphorWeight,
} from '@amable/builder';
import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';

const MAX_RESULTS = 240;
type Library = 'basic' | 'phosphor';

/** Icon setting control: name input + library dialog (basic set and Phosphor). */
export function IconField({
  value,
  onChange,
  disabled,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean | undefined;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const cur = typeof value === 'string' ? value : '';
  const ref = parsePhosphor(cur);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (ref && !hasPhosphor(ref.weight))
      void loadPhosphor(ref.weight).then(() => setTick((n) => n + 1));
  }, [ref?.weight]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = cur && cur !== 'none' ? iconSvg(cur) : '';
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded border text-base [&_svg]:size-5"
        dangerouslySetInnerHTML={{ __html: preview }}
      />
      <Input
        value={cur}
        disabled={disabled}
        className="h-8 text-xs"
        placeholder={t('landing.editor.iconName')}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {t('landing.editor.choose')}
      </Button>
      {open ? (
        <IconLibraryDialog
          value={cur}
          onClose={() => setOpen(false)}
          onPick={(v) => {
            onChange(v);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function IconLibraryDialog({
  value,
  onPick,
  onClose,
}: {
  value: string;
  onPick: (v: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = parsePhosphor(value);
  const [library, setLibrary] = useState<Library>(ref || value === '' ? 'phosphor' : 'basic');
  const [weight, setWeight] = useState<PhosphorWeight>(ref?.weight ?? 'regular');
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<ReadonlyArray<readonly [string, string]> | null>(null);
  const [loaded, setLoaded] = useState<PhosphorWeight | null>(hasPhosphor(weight) ? weight : null);

  useEffect(() => {
    if (library !== 'phosphor') return;
    let live = true;
    void loadPhosphorCatalog().then((c) => live && setCatalog(c));
    void loadPhosphor(weight).then(() => live && setLoaded(weight));
    return () => {
      live = false;
    };
  }, [library, weight]);

  const q = query.trim().toLowerCase();
  const basic = useMemo(() => ICON_NAMES.filter((n) => n.includes(q)), [q]);
  const phosphor = useMemo(() => {
    if (!catalog) return [];
    if (!q) return catalog.map(([n]) => n);
    const words = q.split(/\s+/);
    return catalog
      .filter(([n, terms]) => words.every((w) => n.includes(w) || terms.includes(w)))
      .map(([n]) => n);
  }, [catalog, q]);

  const ready = library === 'basic' || (catalog !== null && loaded === weight);
  const names = library === 'basic' ? basic : phosphor;
  const shown = names.slice(0, MAX_RESULTS);
  const nameOf = (n: string) => (library === 'basic' ? n : phosphorName(n, weight));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[80vh] flex-col gap-3 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('landing.editor.iconLibrary')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          {(['phosphor', 'basic'] as const).map((l) => (
            <Button
              key={l}
              type="button"
              size="sm"
              variant={library === l ? 'default' : 'outline'}
              onClick={() => setLibrary(l)}
            >
              {l === 'basic' ? t('landing.editor.iconBasic') : 'Phosphor'}
            </Button>
          ))}
          <Input
            autoFocus
            value={query}
            className="h-8 min-w-48 flex-1 text-xs"
            placeholder={t('landing.editor.iconSearch')}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button type="button" size="sm" variant="ghost" onClick={() => onPick('none')}>
            ∅ {t('landing.editor.noIcon')}
          </Button>
        </div>
        {library === 'phosphor' ? (
          <div className="flex flex-wrap gap-1">
            {PHOSPHOR_WEIGHTS.map((w) => (
              <Button
                key={w}
                type="button"
                size="sm"
                className="h-7 text-xs"
                variant={weight === w ? 'secondary' : 'ghost'}
                onClick={() => setWeight(w)}
              >
                {t(`landing.editor.iconWeight.${w}`)}
              </Button>
            ))}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto rounded border p-2">
          {!ready ? (
            <p className="p-4 text-center text-sm text-muted-foreground">
              {t('landing.editor.iconLoading')}
            </p>
          ) : shown.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">
              {t('landing.editor.iconNoResults')}
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1">
              {shown.map((n) => {
                const name = nameOf(n);
                return (
                  <button
                    key={n}
                    type="button"
                    title={name}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded border p-2 text-[10px] text-muted-foreground hover:bg-muted [&_svg]:size-7 [&_svg]:text-foreground',
                      value === name && 'border-primary bg-muted',
                    )}
                    onClick={() => onPick(name)}
                  >
                    <span aria-hidden dangerouslySetInnerHTML={{ __html: iconSvg(name) }} />
                    <span className="w-full truncate">{n}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {ready && names.length > shown.length ? (
          <p className="text-xs text-muted-foreground">
            {t('landing.editor.iconMore', {
              shown: String(shown.length),
              total: String(names.length),
            })}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
