import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Bold, Code2, Italic, Link2, List, ListOrdered, RemoveFormatting, Underline } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { useI18n } from '../../../i18n';

type Command = 'bold' | 'italic' | 'underline' | 'insertUnorderedList' | 'insertOrderedList' | 'removeFormat' | 'createLink';

/**
 * Small HTML rich-text field for builder `richtext` controls (the value is an
 * HTML string, sanitized by the renderer). Uses the browser editing commands;
 * the `</>` toggle on the right edits the HTML source directly.
 */
export function RichTextField({ value, onChange, disabled }: { value: string; onChange: (html: string) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef(value);
  const [codeView, setCodeView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el && value !== last.current && document.activeElement !== el) {
      el.innerHTML = value;
      last.current = value;
    }
  }, [value]);

  // On mount and whenever the visual view returns: the contentEditable div is
  // remounted empty, so it is filled by hand with the current value.
  useEffect(() => {
    if (!codeView && ref.current) {
      ref.current.innerHTML = value;
      last.current = value;
    }
    // `value` edits are handled by the sync effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeView]);

  const emit = () => {
    const html = ref.current?.innerHTML ?? '';
    last.current = html;
    onChange(html);
  };

  const run = (command: Command) => {
    if (disabled) return;
    ref.current?.focus();
    if (command === 'createLink') {
      const url = window.prompt(t('landing.editor.linkPrompt'), 'https://');
      if (!url || !/^(https?:|mailto:|tel:|#|\/)/i.test(url.trim())) return;
      document.execCommand('createLink', false, url.trim());
    } else {
      document.execCommand(command);
    }
    emit();
  };

  const tools: { command: Command; icon: ComponentType<{ className?: string }>; label: string }[] = [
    { command: 'bold', icon: Bold, label: t('landing.editor.rt.bold') },
    { command: 'italic', icon: Italic, label: t('landing.editor.rt.italic') },
    { command: 'underline', icon: Underline, label: t('landing.editor.rt.underline') },
    { command: 'insertUnorderedList', icon: List, label: t('landing.editor.rt.bullets') },
    { command: 'insertOrderedList', icon: ListOrdered, label: t('landing.editor.rt.numbers') },
    { command: 'createLink', icon: Link2, label: t('landing.editor.rt.link') },
    { command: 'removeFormat', icon: RemoveFormatting, label: t('landing.editor.rt.clear') },
  ];

  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center gap-0.5 border-b p-1">
        {tools.map(({ command, icon: Icon, label }) => (
          <Button
            key={command}
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={label}
            title={label}
            disabled={disabled || codeView}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(command)}
          >
            <Icon className="size-3.5" />
          </Button>
        ))}
        <Button
          type="button"
          variant={codeView ? 'secondary' : 'ghost'}
          size="icon"
          className="ml-auto size-7"
          aria-label={codeView ? t('landing.editor.rt.visual') : t('landing.editor.rt.html')}
          aria-pressed={codeView}
          title={codeView ? t('landing.editor.rt.visual') : t('landing.editor.rt.html')}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setCodeView((v) => !v)}
        >
          <Code2 className="size-3.5" />
        </Button>
      </div>
      {codeView ? (
        <textarea
          value={value}
          disabled={disabled}
          spellCheck={false}
          aria-label={t('landing.editor.rt.html')}
          className={cn('min-h-24 w-full resize-y bg-transparent px-2 py-1.5 font-mono text-xs outline-none', disabled && 'opacity-60')}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div
          ref={ref}
          role="textbox"
          aria-multiline="true"
          contentEditable={!disabled}
          suppressContentEditableWarning
          className={cn('min-h-24 px-2 py-1.5 text-sm outline-none [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5', disabled && 'opacity-60')}
          onInput={emit}
          onBlur={emit}
        />
      )}
    </div>
  );
}
