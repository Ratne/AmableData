import type { ImportJob } from '@amable/api-types/crm';
import { cn, DashboardButton, PageBody, usePageChrome } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Checkbox } from '@amable/ui/ui/checkbox';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Progress } from '@amable/ui/ui/progress';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CheckCircle2, FileUp, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useI18n } from '../../../i18n';
import { CrmApiError } from '../api/client';
import { crmKeys, errorMessage, useCrm, useCustomFields, usePermissions } from '../api/hooks';
import { STANDARD_FIELD_LABELS } from '../field-catalog';
import {
  duplicateTargets,
  guessMapping,
  IMPORT_TARGETS,
  parseCsvPreview,
  type ImportTarget,
} from '../import-mapping';
import { ChoiceSelect, TagMultiSelect } from '../components/inputs';
import { ErrorNotice } from '../components/states';

const MAX_BYTES = 50 * 1024 * 1024;
type Step = 'upload' | 'map' | 'run' | 'done';

export function ImportWizardPage() {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const { can, ready } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const customFields = useCustomFields('contacts');
  usePageChrome({ title: t('crm.import.title') });

  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, ImportTarget>>({});
  const [updateExisting, setUpdateExisting] = useState(true);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [delimiter, setDelimiter] = useState(';');
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dragging, setDragging] = useState(false);
  const poll = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (poll.current !== null) window.clearInterval(poll.current);
    },
    [],
  );

  const headers = preview[0] ?? [];
  const samples = preview.slice(1);

  const choose = async (picked: File | undefined) => {
    setError(null);
    if (!picked) return;
    if (picked.size > MAX_BYTES) {
      setError(new Error(t('crm.import.tooLarge')));
      return;
    }
    const head = await picked.slice(0, 64 * 1024).text();
    const rows = parseCsvPreview(head, 6);
    if (rows.length === 0) {
      setError(new Error(t('crm.import.empty')));
      return;
    }
    setFile(picked);
    setPreview(rows);
    setMapping(guessMapping(rows[0] ?? [], customFields.fields));
    setStep('map');
  };

  const targetChoices = [
    { value: 'ignore', label: t('crm.import.ignore') },
    ...IMPORT_TARGETS.map((target) => ({
      value: target,
      label: importTargetLabel(target, t),
    })),
    ...customFields.fields.map((field) => ({
      value: `custom.${field.key}`,
      label: `${field.label} (${t('search.customBadge')})`,
    })),
  ];
  const duplicates = duplicateTargets(mapping);
  const mapped = Object.values(mapping).filter((target) => target !== 'ignore').length;

  const run = async () => {
    if (!file) return;
    setStep('run');
    setError(null);
    try {
      const created = await api.imports.create({
        entity: 'contact',
        mapping,
        options: {
          update_existing: updateExisting,
          list_delimiter: delimiter || ';',
          ...(tagIds.length > 0 ? { tag_ids: tagIds } : {}),
        },
      });
      setJob(created);
      poll.current = window.setInterval(() => {
        void api.imports
          .get(created.id)
          .then((current) =>
            setJob((previous) => (previous?.status === 'completed' ? previous : current)),
          )
          .catch(() => undefined);
      }, 1000);
      const finished = await api.imports.upload(created.id, file);
      setJob(finished);
      setStep('done');
      await queryClient.invalidateQueries({ queryKey: crmKeys.root(slug) });
    } catch (failure) {
      setError(failure);
      setStep('map');
    } finally {
      if (poll.current !== null) window.clearInterval(poll.current);
      poll.current = null;
    }
  };

  if (!ready) return null;
  if (!can('contacts:import')) {
    return (
      <PageBody className="pt-4">
        <ErrorNotice error={new CrmApiError(403, 'forbidden', null, [])} />
      </PageBody>
    );
  }

  const steps: Step[] = ['upload', 'map', 'run', 'done'];
  return (
    <PageBody className="grid max-w-5xl gap-4 pt-4">
      <ol className="flex flex-wrap gap-2 text-xs" aria-label={t('crm.import.steps')}>
        {steps.map((name, index) => (
          <li
            key={name}
            aria-current={name === step ? 'step' : undefined}
            className={cn(
              'rounded-full border px-3 py-1',
              name === step ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground',
            )}
          >
            {index + 1}. {t(`crm.import.step.${name}`)}
          </li>
        ))}
      </ol>

      {error ? (
        error instanceof Error && !('status' in error) ? (
          <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
            <TriangleAlert className="size-4" aria-hidden /> {error.message}
          </p>
        ) : (
          <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
            <TriangleAlert className="size-4" aria-hidden /> {errorMessage(t, error)}
          </p>
        )
      ) : null}

      {step === 'upload' ? (
        <label
          onDragOver={(event: DragEvent) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            setDragging(false);
            void choose(event.dataTransfer.files[0]);
          }}
          className={cn(
            'flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed p-10 text-center',
            dragging && 'border-primary bg-primary/5',
          )}
        >
          <FileUp className="size-8 text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium">{t('crm.import.drop')}</span>
          <span className="text-xs text-muted-foreground">{t('crm.import.dropHint')}</span>
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            aria-label={t('crm.import.chooseFile')}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
        </label>
      ) : null}

      {step === 'map' && file ? (
        <section className="grid gap-4">
          <p className="text-sm">
            <span className="font-medium">{file.name}</span>{' '}
            <span className="text-muted-foreground">
              · {t('crm.import.columns', { count: headers.length })} ·{' '}
              {t('crm.import.mappedCount', { count: mapped })}
            </span>
          </p>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('crm.import.csvColumn')}</th>
                  <th className="px-3 py-2 font-medium">{t('crm.import.sample')}</th>
                  <th className="px-3 py-2 font-medium">{t('crm.import.target')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {headers.map((header, column) => (
                  <tr key={`${header}-${String(column)}`}>
                    <td className="px-3 py-2 font-medium">{header}</td>
                    <td className="max-w-64 truncate px-3 py-2 text-muted-foreground">
                      {samples
                        .map((row) => row[column] ?? '')
                        .filter(Boolean)
                        .slice(0, 3)
                        .join(' · ')}
                    </td>
                    <td className="px-3 py-2">
                      <ChoiceSelect
                        value={mapping[header] ?? 'ignore'}
                        allowEmpty={false}
                        ariaLabel={t('crm.import.targetFor', { column: header })}
                        invalid={duplicates.includes(mapping[header] ?? '')}
                        className="w-60"
                        choices={targetChoices}
                        onChange={(value) =>
                          setMapping({ ...mapping, [header]: value as ImportTarget })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {duplicates.length > 0 ? (
            <p role="alert" className="text-sm text-destructive">
              {t('crm.import.duplicates', { targets: duplicates.join(', ') })}
            </p>
          ) : null}
          <div className="grid gap-3 rounded-xl border p-4 sm:grid-cols-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={updateExisting}
                onCheckedChange={(v) => setUpdateExisting(v === true)}
              />
              {t('crm.import.updateExisting')}
            </label>
            <div className="grid gap-1.5">
              <Label>{t('crm.import.applyTags')}</Label>
              <TagMultiSelect
                values={tagIds}
                onChange={setTagIds}
                ariaLabel={t('crm.import.applyTags')}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="import-delimiter">{t('crm.import.listDelimiter')}</Label>
              <Input
                id="import-delimiter"
                value={delimiter}
                maxLength={3}
                className="h-8 w-20 font-mono"
                onChange={(e) => setDelimiter(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-between gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setStep('upload');
                setFile(null);
              }}
            >
              {t('common.back')}
            </Button>
            <Button disabled={mapped === 0 || duplicates.length > 0} onClick={() => void run()}>
              {t('crm.import.start')}
            </Button>
          </div>
        </section>
      ) : null}

      {step === 'run' ? (
        <section className="grid gap-3 rounded-xl border p-6" aria-live="polite">
          <p className="text-sm font-medium">{t('crm.import.running')}</p>
          <Progress
            value={
              job && job.total_rows > 0
                ? Math.min(99, ((job.created + job.updated + job.failed) / job.total_rows) * 100)
                : 15
            }
          />
          {job ? (
            <p className="text-xs text-muted-foreground">
              {t('crm.import.progress', { done: job.created + job.updated + job.failed })}
            </p>
          ) : null}
        </section>
      ) : null}

      {step === 'done' && job ? (
        <section className="grid gap-4 rounded-xl border p-6">
          <p className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2 className="size-5 text-emerald-600" aria-hidden />
            {job.status === 'completed' ? t('crm.import.completed') : t('crm.import.failed')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">
              {t('crm.import.result.total', { count: job.total_rows })}
            </Badge>
            <Badge>{t('crm.import.result.created', { count: job.created })}</Badge>
            <Badge variant="secondary">
              {t('crm.import.result.updated', { count: job.updated })}
            </Badge>
            <Badge variant={job.failed > 0 ? 'destructive' : 'outline'}>
              {t('crm.import.result.failed', { count: job.failed })}
            </Badge>
          </div>
          {job.errors.length > 0 ? (
            <div className="max-h-64 overflow-y-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">{t('crm.import.row')}</th>
                    <th className="px-3 py-1.5 font-medium">{t('crm.import.error')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {job.errors.map((rowError) => (
                    <tr key={`${String(rowError.row)}-${rowError.message}`}>
                      <td className="px-3 py-1.5 tabular-nums">{rowError.row}</td>
                      <td className="px-3 py-1.5">{rowError.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div className="flex gap-2">
            <DashboardButton
              variant="primary"
              onClick={() => void navigate({ to: '/t/$tenant/contacts', params: { tenant: slug } })}
            >
              {t('crm.import.viewContacts')}
            </DashboardButton>
            <DashboardButton
              variant="ghost"
              onClick={() => {
                setStep('upload');
                setFile(null);
                setJob(null);
              }}
            >
              {t('crm.import.another')}
            </DashboardButton>
          </div>
        </section>
      ) : null}
    </PageBody>
  );
}

type Translate = ReturnType<typeof useI18n>['t'];

function importTargetLabel(target: (typeof IMPORT_TARGETS)[number], t: Translate): string {
  if (target.startsWith('address.')) {
    const part = target.slice('address.'.length) as
      'line1' | 'street_number' | 'line2' | 'locality' | 'region' | 'postal_code' | 'country_code';
    return `${t('crm.contact.addresses')}: ${t(`crm.address.${part}`)}`;
  }
  if (target === 'email2' || target === 'email3')
    return `${t('crm.field.email')} ${target.slice(-1)}`;
  if (target === 'phone2' || target === 'phone3')
    return `${t('crm.field.phone')} ${target.slice(-1)}`;
  if (target === 'lead_source') return t('crm.field.lead_source_id');
  const key = STANDARD_FIELD_LABELS[target];
  return key ? t(key) : target;
}
