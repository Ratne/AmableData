import {
  breakpointChain,
  evalCondition,
  getStyleValue,
  getWidgetDef,
  responsiveSettingKey,
  responsiveSettingKeys,
  sectionsForType,
  type Breakpoint,
  type ControlDef,
  type ElementNode,
  type ElementState,
} from '@amable/builder';
import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { BookmarkPlus, ChevronDown, ChevronRight, ClipboardCopy, CopyPlus, Lock, Trash2, Unlock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { useBuilderLabel } from '../lib/builder-i18n';
import { ControlField } from './controls';

type Tab = 'content' | 'style' | 'advanced';

const CHIP_CLASS: Record<Breakpoint, string> = {
  desktop: 'bg-slate-500',
  laptop: 'bg-teal-500',
  tablet: 'bg-amber-500',
  mobile: 'bg-sky-500',
  mobilesm: 'bg-indigo-500',
};

/** Shows on which breakpoint/state a control has a value, with a quick reset. */
function OverrideChips({
  overrides,
  currentBp,
  currentState,
  disabled,
  onReset,
}: {
  overrides: { bp: Breakpoint; st: ElementState }[];
  currentBp: Breakpoint;
  currentState: ElementState;
  disabled?: boolean;
  onReset: (bp: Breakpoint, st: ElementState) => void;
}) {
  const { t } = useI18n();
  const only = overrides[0];
  if (!only || (overrides.length === 1 && only.bp === 'desktop' && only.st === 'normal')) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {overrides.map(({ bp, st }) => {
        const name = st === 'hover' ? `${t(`landing.device.${bp}`)}:${t('landing.editor.state.hover')}` : t(`landing.device.${bp}`);
        const current = bp === currentBp && st === currentState;
        return (
          <span
            key={`${bp}:${st}`}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold text-white',
              st === 'hover' ? 'bg-violet-500' : CHIP_CLASS[bp],
              current && 'ring-1 ring-slate-400 ring-offset-1',
            )}
            title={t('landing.editor.overrideHint', { device: name })}
          >
            {name}
            {!disabled ? (
              <button type="button" className="opacity-75 hover:opacity-100" aria-label={t('landing.editor.resetOverride', { device: name })} onClick={() => onReset(bp, st)}>
                ×
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/** Controls of the selected node, generated from its widget sections + the shared advanced sections. */
export function ControlsPanel({
  node,
  breakpoint,
  disabled,
  popups,
  anchors,
  onUpdateSettings,
  onSetStyle,
  onToggleLock,
  onDuplicate,
  onCopy,
  onRemove,
  onSaveSection,
}: {
  node: ElementNode;
  breakpoint: Breakpoint;
  disabled?: boolean;
  popups: { id: string; name: string }[];
  anchors: { id: string; label: string }[];
  onUpdateSettings: (patch: Record<string, unknown>) => void;
  onSetStyle: (key: string, value: unknown, bp: Breakpoint, state: ElementState) => void;
  onToggleLock: () => void;
  onDuplicate: () => void;
  /** Copies the node to the clipboard (always allowed: read-only action). */
  onCopy?: () => void;
  onRemove: () => void;
  onSaveSection?: () => void;
}) {
  const { t } = useI18n();
  const label = useBuilderLabel();
  const def = getWidgetDef(node.type);
  const sections = useMemo(() => sectionsForType(node.type), [node.type]);
  const [tab, setTab] = useState<Tab>('content');
  const [state, setState] = useState<ElementState>('normal');
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});

  const tabs = useMemo(() => {
    const present = new Set(sections.map((s) => s.tab));
    return (['content', 'style', 'advanced'] as Tab[]).filter((x) => present.has(x));
  }, [sections]);
  const activeTab = tabs.includes(tab) ? tab : (tabs[0] ?? 'content');
  const visibleSections = sections.filter((s) => s.tab === activeTab);

  /**
   * Values the `condition`s are evaluated against: settings plus the style
   * values of the current breakpoint/state (several conditions point to style
   * keys). Responsive values inherit from wider breakpoints, like CSS; missing
   * keys become "" so `{"key!": ""}` really means "only when set".
   */
  const conditionValues = useMemo(() => {
    const keys = new Set<string>();
    const byKey = new Map<string, ControlDef>();
    for (const s of sections) {
      for (const raw of Object.keys(s.condition ?? {})) keys.add(raw.replace(/!$/, ''));
      for (const c of s.controls) {
        byKey.set(c.key, c);
        for (const raw of Object.keys(c.condition ?? {})) keys.add(raw.replace(/!$/, ''));
      }
    }
    const inherited = (pick: (bp: Breakpoint) => unknown): unknown => {
      for (const bp of breakpointChain(breakpoint)) {
        const v = pick(bp);
        if (v !== undefined && v !== null && v !== '') return v;
      }
      return undefined;
    };
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const ctrl = byKey.get(key);
      const st = ctrl?.states?.includes(state) ? state : 'normal';
      let raw: unknown;
      if (ctrl && ctrl.group === 'style') {
        raw = ctrl.responsive ? inherited((bp) => getStyleValue(node, key, bp, st)) : getStyleValue(node, key, 'desktop', st);
      } else if (ctrl?.responsive) {
        raw = inherited((bp) => node.settings[responsiveSettingKey(key, bp)]);
      } else {
        raw = node.settings[key];
      }
      out[key] = raw === undefined || raw === null ? '' : raw;
    }
    return out;
  }, [sections, node, breakpoint, state]);

  const settingKeyOf = (ctrl: ControlDef) => (ctrl.responsive ? responsiveSettingKey(ctrl.key, breakpoint) : ctrl.key);

  const valueOf = (ctrl: ControlDef): unknown => {
    // The shape control manages several settings keys: it gets all settings and emits a patch.
    if (ctrl.type === 'shape') return node.settings;
    if (ctrl.group === 'content') return node.settings[settingKeyOf(ctrl)];
    const bp = ctrl.responsive ? breakpoint : 'desktop';
    const st = ctrl.states?.includes(state) ? state : 'normal';
    return getStyleValue(node, ctrl.key, bp, st);
  };

  const overridesOf = (ctrl: ControlDef): { bp: Breakpoint; st: ElementState }[] => {
    if (ctrl.group === 'content') {
      if (!ctrl.responsive) return [];
      return responsiveSettingKeys(ctrl.key)
        .filter(({ key }) => {
          const v = node.settings[key];
          return v !== undefined && v !== null && v !== '';
        })
        .map(({ bp }) => ({ bp, st: 'normal' as ElementState }));
    }
    return node.styles.filter((v) => v.props[ctrl.key] !== undefined).map((v) => ({ bp: v.breakpoint, st: v.state }));
  };

  const resetOverride = (ctrl: ControlDef, bp: Breakpoint, st: ElementState) => {
    if (ctrl.group === 'content') onUpdateSettings({ [responsiveSettingKey(ctrl.key, bp)]: undefined });
    else onSetStyle(ctrl.key, undefined, bp, st);
  };

  const changeOf = (ctrl: ControlDef, value: unknown) => {
    if (disabled) return;
    if (ctrl.type === 'shape') {
      onUpdateSettings(value as Record<string, unknown>);
      return;
    }
    if (ctrl.group === 'content') {
      onUpdateSettings({ [settingKeyOf(ctrl)]: value });
    } else {
      const bp = ctrl.responsive ? breakpoint : 'desktop';
      const st = ctrl.states?.includes(state) ? state : 'normal';
      onSetStyle(ctrl.key, value, bp, st);
    }
  };

  const hasHover = visibleSections.some((s) => s.controls.some((c) => c.group === 'style' && c.states?.includes('hover')));
  const deviceName = t(`landing.device.${breakpoint}`);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{label(def?.title) || node.type}</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">{node.id}</div>
        </div>
        <div className="flex items-center gap-1">
          {onSaveSection ? (
            <Button variant="ghost" size="icon" className="size-7" aria-label={t('landing.sections.save')} title={t('landing.sections.save')} onClick={onSaveSection} disabled={disabled}>
              <BookmarkPlus className="size-4" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={node.locked ? t('landing.editor.unlock') : t('landing.editor.lock')}
            title={node.locked ? t('landing.editor.unlock') : t('landing.editor.lock')}
            onClick={onToggleLock}
            disabled={disabled}
          >
            {node.locked ? <Lock className="size-4" /> : <Unlock className="size-4" />}
          </Button>
          {onCopy ? (
            <Button variant="ghost" size="icon" className="size-7" aria-label={t('landing.editor.copyToClipboard')} title={t('landing.editor.copyToClipboard')} onClick={onCopy}>
              <ClipboardCopy className="size-4" />
            </Button>
          ) : null}
          <Button variant="ghost" size="icon" className="size-7" aria-label={t('landing.editor.duplicate')} title={t('landing.editor.duplicate')} onClick={onDuplicate} disabled={disabled}>
            <CopyPlus className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7 text-destructive" aria-label={t('landing.editor.delete')} title={t('landing.editor.delete')} onClick={onRemove} disabled={disabled}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex border-b text-sm" role="tablist">
        {tabs.map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            aria-selected={activeTab === x}
            onClick={() => setTab(x)}
            className={cn('flex-1 px-2 py-2', activeTab === x ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground')}
          >
            {t(`landing.editor.tab.${x}`)}
          </button>
        ))}
      </div>

      {breakpoint !== 'desktop' ? (
        <div className="border-b bg-amber-500/10 px-3 py-1.5 text-[11px] leading-snug text-amber-800 dark:text-amber-200">
          {t('landing.editor.editingDevice', { device: deviceName })}
        </div>
      ) : null}

      {activeTab === 'style' && hasHover ? (
        <div className="flex items-center gap-1 border-b px-3 py-1.5 text-xs">
          <span className="text-muted-foreground">{t('landing.editor.state')}</span>
          {(['normal', 'hover'] as const).map((st) => (
            <button
              key={st}
              type="button"
              aria-pressed={state === st}
              onClick={() => setState(st)}
              className={cn('rounded px-2 py-0.5', state === st ? 'bg-muted font-medium' : 'text-muted-foreground')}
            >
              {t(`landing.editor.state.${st}`)}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        {visibleSections.map((section) => {
          if (!evalCondition(section.condition, conditionValues)) return null;
          const controls = section.controls.filter((c) => c.type !== 'hidden' && evalCondition(c.condition, conditionValues));
          if (controls.length === 0) return null;
          const open = openSections[section.id] ?? true;
          return (
            <div key={section.id} className="rounded-md border">
              <button
                type="button"
                aria-expanded={open}
                className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-muted-foreground uppercase"
                onClick={() => setOpenSections((o) => ({ ...o, [section.id]: !open }))}
              >
                {label(section.label)}
                {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              </button>
              {open ? (
                <div className="flex flex-col gap-3 border-t p-3">
                  {controls.map((ctrl) => (
                    <div key={ctrl.key} className="flex flex-col gap-1">
                      <ControlField
                        def={ctrl}
                        value={valueOf(ctrl)}
                        disabled={disabled}
                        popups={popups}
                        anchors={anchors}
                        widgetType={node.type}
                        labelBadge={ctrl.responsive && breakpoint !== 'desktop' ? deviceName : undefined}
                        onChange={(v) => changeOf(ctrl, v)}
                      />
                      <OverrideChips
                        overrides={overridesOf(ctrl)}
                        currentBp={ctrl.responsive ? breakpoint : 'desktop'}
                        currentState={ctrl.states?.includes(state) ? state : 'normal'}
                        disabled={disabled}
                        onReset={(bp, st) => resetOverride(ctrl, bp, st)}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
