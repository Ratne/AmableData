import {
  DashboardButton,
  DashboardFilterMenu,
  ListTable,
  PageBody,
  PageToolbar,
  toast,
  usePageChrome,
  type ListTableColumn,
} from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Calendar } from '@amable/ui/ui/calendar';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@amable/ui/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@amable/ui/ui/popover';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@amable/ui/ui/sheet';
import { Tag, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { listTableLabels } from '../../lib/labels';

interface DemoContact {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly score: number;
  readonly createdAt: Date;
  readonly vip: boolean;
}

const SEED: DemoContact[] = Array.from({ length: 12 }, (_, index) => ({
  id: `c${String(index + 1)}`,
  name:
    [
      'Ada Lovelace',
      'Alan Turing',
      'Grace Hopper',
      'Linus Torvalds',
      'Margaret Hamilton',
      'Dennis Ritchie',
    ][index % 6] + (index >= 6 ? ' II' : ''),
  email: `person${String(index + 1)}@example.com`,
  score: (index * 37) % 100,
  createdAt: new Date(Date.UTC(2026, 8, 1 + index * 2)),
  vip: index % 3 === 0,
}));

/** Dev-only page: the standard list table and the restyled generic components side by side. */
export function UiKitPage() {
  const { t, locale } = useI18n();
  usePageChrome({ title: t('dev.uiKit.title'), status: 'dev', statusTone: 'warning' });
  const [rows, setRows] = useState(SEED);
  const [archive, setArchive] = useState<DemoContact[]>([]);
  const [segment, setSegment] = useState('all');
  const [date, setDate] = useState<Date | undefined>(undefined);
  const labels = useMemo(() => listTableLabels(t), [t]);
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }),
    [locale],
  );

  const columns: ListTableColumn<DemoContact>[] = [
    {
      id: 'name',
      header: t('nav.contacts'),
      sortable: true,
      sortValue: (row) => row.name,
      cell: (row) => (
        <span className="flex flex-col gap-1">
          <span className="font-medium leading-none">{row.name}</span>
          <span className="text-xs leading-none text-(--obsidian-dashboard-shell-text-subtle)">
            {row.email}
          </span>
        </span>
      ),
    },
    {
      id: 'score',
      header: 'Score',
      sortable: true,
      firstDirection: 'desc',
      sortValue: (row) => row.score,
      align: 'right',
      cell: (row) => <span className="tabular-nums">{row.score}</span>,
    },
    {
      id: 'created',
      header: 'Created',
      sortable: true,
      firstDirection: 'desc',
      hideBelow: 'md',
      sortValue: (row) => row.createdAt,
      cell: (row) => dateFormat.format(row.createdAt),
    },
    {
      id: 'tags',
      header: t('nav.tags'),
      hideBelow: 'lg',
      cell: (row) => (row.vip ? <Badge variant="secondary">VIP</Badge> : null),
    },
  ];

  const visible = segment === 'vip' ? rows.filter((row) => row.vip) : rows;

  return (
    <>
      <PageToolbar
        filters={
          <DashboardFilterMenu
            label="Segment"
            value={segment}
            onValueChange={setSegment}
            options={[
              { value: 'all', label: 'All' },
              { value: 'vip', label: 'VIP' },
            ]}
          />
        }
        actions={
          <DashboardButton variant="primary" size="sm" onClick={() => toast.success('Created')}>
            <Plus aria-hidden />
            New
          </DashboardButton>
        }
      />
      <ListTable
        className="min-h-0"
        rows={visible}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
        columns={columns}
        defaultSort={{ columnId: 'name', direction: 'asc' }}
        labels={labels}
        rowActions={[
          {
            id: 'tag',
            label: 'Toggle VIP',
            icon: Tag,
            onSelect: (row) =>
              setRows((current) =>
                current.map((r) => (r.id === row.id ? { ...r, vip: !r.vip } : r)),
              ),
          },
        ]}
        bulkActions={[
          {
            id: 'vip',
            label: 'Mark VIP',
            icon: Tag,
            onSelect: (selected) =>
              setRows((current) =>
                current.map((r) => (selected.some((s) => s.id === r.id) ? { ...r, vip: true } : r)),
              ),
          },
        ]}
        deletion={{
          onDelete: (targets) => {
            setArchive((current) => [...current, ...targets]);
            setRows((current) =>
              current.filter((row) => !targets.some((target) => target.id === row.id)),
            );
          },
          onUndo: (targets) => {
            setArchive((current) =>
              current.filter((row) => !targets.some((target) => target.id === row.id)),
            );
            setRows((current) => [...current, ...targets]);
          },
        }}
      />
      <PageBody className="grid gap-6 pt-8 md:grid-cols-2">
        <section className="grid content-start gap-3">
          <h2 className="text-sm font-medium">Inputs & overlays</h2>
          <Input placeholder="Email" type="email" />
          <div className="flex flex-wrap gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Dialog</DialogTitle>
                  <DialogDescription>
                    Generic dialog restyled with the shell palette.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button onClick={() => toast('Saved')}>Save</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">Sheet</Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Sheet</SheetTitle>
                </SheetHeader>
              </SheetContent>
            </Sheet>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">{date ? dateFormat.format(date) : 'Pick a date'}</Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={date} onSelect={setDate} />
              </PopoverContent>
            </Popover>
            <Button variant="secondary" onClick={() => toast.success('Toast from sonner')}>
              Toast
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Archived (undo target): {archive.length}</p>
        </section>
        <section className="grid content-start gap-3">
          <h2 className="text-sm font-medium">Command palette</h2>
          <Command className="rounded-lg border">
            <CommandInput placeholder="Search…" />
            <CommandList>
              <CommandEmpty>—</CommandEmpty>
              <CommandGroup heading={t('nav.group.crm')}>
                <CommandItem>{t('nav.contacts')}</CommandItem>
                <CommandItem>{t('nav.companies')}</CommandItem>
                <CommandItem>{t('nav.deals')}</CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </section>
      </PageBody>
    </>
  );
}
