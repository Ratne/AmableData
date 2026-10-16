import type { Product, ProductCategory } from '@amable/api-types';
import {
  DashboardButton,
  ListTable,
  PageBody,
  PageToolbar,
  usePageChrome,
  type ListTableColumn,
} from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Textarea } from '@amable/ui/ui/textarea';
import { useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import {
  commerceKeys,
  useCatalog,
  useCategories,
  useCommerce,
  useCommerceMutation,
  useMoney,
  usePermissions,
} from '../api/hooks';
import { ChoiceSelect, ErrorNotice, FormField, Pill, SearchInput } from '../components/common';
import { formatBps } from '../lib/money';
import { useQueryClient } from '@tanstack/react-query';

type Tab = 'products' | 'categories';

export function ProductsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('products');
  usePageChrome({
    title: t('nav.products'),
    tabs: [
      { value: 'products', label: t('commerce.products.tab') },
      { value: 'categories', label: t('commerce.categories.tab') },
    ],
    tab,
    onTabChange: (value) => setTab(value === 'categories' ? 'categories' : 'products'),
  });
  return tab === 'products' ? <ProductsTab /> : <CategoriesTab />;
}

function ProductsTab() {
  const { t, locale } = useI18n();
  const { slug, api } = useCommerce();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const money = useMoney();
  const queryClient = useQueryClient();
  const catalog = useCatalog();
  const { categories, byId: categoryById } = useCategories();
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [active, setActive] = useState('');

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return catalog.products.filter(
      (p) =>
        (!needle ||
          p.name.toLowerCase().includes(needle) ||
          (p.sku ?? '').toLowerCase().includes(needle)) &&
        (!categoryId || p.category_id === categoryId) &&
        (!active || String(p.active) === active),
    );
  }, [catalog.products, q, categoryId, active]);

  const columns: ListTableColumn<Product>[] = [
    {
      id: 'name',
      header: t('commerce.field.name'),
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{p.name}</span>
          {p.sku ? <span className="truncate text-xs text-muted-foreground">{p.sku}</span> : null}
        </span>
      ),
      sortable: true,
      sortValue: (p) => p.name,
    },
    {
      id: 'category',
      header: t('commerce.field.category'),
      cell: (p) => (p.category_id ? (categoryById.get(p.category_id)?.name ?? '—') : '—'),
      sortable: true,
      sortValue: (p) => (p.category_id ? (categoryById.get(p.category_id)?.name ?? '') : ''),
      hideBelow: 'md',
    },
    {
      id: 'plans',
      header: t('commerce.field.plans'),
      cell: (p) => (p.plans.length > 0 ? p.plans.length : '—'),
      align: 'right',
      hideBelow: 'lg',
    },
    {
      id: 'tax',
      header: t('commerce.field.taxRate'),
      cell: (p) => formatBps(p.tax_rate_bps, locale),
      align: 'right',
      hideBelow: 'lg',
    },
    {
      id: 'status',
      header: t('commerce.field.status'),
      cell: (p) =>
        p.active ? (
          <Pill tone="success">{t('commerce.common.active')}</Pill>
        ) : (
          <Pill tone="neutral">{t('commerce.common.inactive')}</Pill>
        ),
      sortable: true,
      sortValue: (p) => (p.active ? 0 : 1),
    },
    {
      id: 'price',
      header: t('commerce.field.price'),
      cell: (p) => <span className="tabular-nums">{money(p.price_minor, p.currency)}</span>,
      align: 'right',
      sortable: true,
      sortValue: (p) => p.price_minor,
      firstDirection: 'desc',
    },
  ];

  return (
    <>
      <PageToolbar
        filters={
          <>
            <SearchInput value={q} onChange={setQ} placeholder={t('commerce.products.search')} />
            <ChoiceSelect
              value={categoryId}
              onChange={setCategoryId}
              emptyLabel={t('commerce.products.allCategories')}
              ariaLabel={t('commerce.field.category')}
              choices={categories.map((c) => ({ value: c.id, label: c.name }))}
            />
            <ChoiceSelect
              value={active}
              onChange={setActive}
              emptyLabel={t('commerce.common.allStatuses')}
              ariaLabel={t('commerce.field.status')}
              choices={[
                { value: 'true', label: t('commerce.common.active') },
                { value: 'false', label: t('commerce.common.inactive') },
              ]}
            />
          </>
        }
        actions={
          can('products:write') ? (
            <DashboardButton
              variant="primary"
              onClick={() =>
                void navigate({
                  to: '/t/$tenant/products/$productId',
                  params: { tenant: slug, productId: 'new' },
                })
              }
            >
              <Plus aria-hidden /> {t('commerce.products.new')}
            </DashboardButton>
          ) : null
        }
      />
      {catalog.error ? (
        <PageBody>
          <ErrorNotice error={catalog.error} />
        </PageBody>
      ) : (
        <ListTable<Product>
          className="px-4"
          rows={rows}
          getRowId={(p) => p.id}
          getRowLabel={(p) => p.name}
          columns={columns}
          labels={listTableLabels(t)}
          defaultSort={{ columnId: 'name', direction: 'asc' }}
          selectable={can('products:write')}
          loading={catalog.isPending}
          onRowOpen={(p) =>
            void navigate({
              to: '/t/$tenant/products/$productId',
              params: { tenant: slug, productId: p.id },
            })
          }
          deletion={
            can('products:write')
              ? {
                  onDelete: async (selected) => {
                    await Promise.all(selected.map((p) => api.products.remove(p.id)));
                    await queryClient.invalidateQueries({ queryKey: commerceKeys.root(slug) });
                  },
                }
              : undefined
          }
          emptyState={
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t('commerce.products.empty')}
            </p>
          }
        />
      )}
    </>
  );
}

function CategoriesTab() {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const { categories, isPending, error } = useCategories();
  const [editing, setEditing] = useState<ProductCategory | 'new' | null>(null);

  const columns: ListTableColumn<ProductCategory>[] = [
    {
      id: 'name',
      header: t('commerce.field.name'),
      cell: (c) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{c.name}</span>
          {c.description ? (
            <span className="truncate text-xs text-muted-foreground">{c.description}</span>
          ) : null}
        </span>
      ),
      sortable: true,
      sortValue: (c) => c.name,
    },
    {
      id: 'products',
      header: t('nav.products'),
      cell: (c) => c.product_count,
      align: 'right',
      sortable: true,
      sortValue: (c) => c.product_count,
    },
  ];

  return (
    <>
      <PageToolbar
        actions={
          can('products:write') ? (
            <DashboardButton variant="primary" onClick={() => setEditing('new')}>
              <Plus aria-hidden /> {t('commerce.categories.new')}
            </DashboardButton>
          ) : null
        }
      />
      {error ? (
        <PageBody>
          <ErrorNotice error={error} />
        </PageBody>
      ) : (
        <ListTable<ProductCategory>
          className="px-4"
          rows={categories}
          getRowId={(c) => c.id}
          getRowLabel={(c) => c.name}
          columns={columns}
          labels={listTableLabels(t)}
          selectable={false}
          loading={isPending}
          onRowOpen={can('products:write') ? (c) => setEditing(c) : undefined}
          deletion={
            can('products:write')
              ? {
                  onDelete: async (selected) => {
                    await Promise.all(selected.map((c) => api.categories.remove(c.id)));
                    await queryClient.invalidateQueries({ queryKey: commerceKeys.root(slug) });
                  },
                }
              : undefined
          }
          emptyState={
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t('commerce.categories.empty')}
            </p>
          }
        />
      )}
      {editing !== null ? (
        <CategoryDialog
          category={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function CategoryDialog({
  category,
  onClose,
}: {
  category: ProductCategory | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { api } = useCommerce();
  const [name, setName] = useState(category?.name ?? '');
  const [description, setDescription] = useState(category?.description ?? '');
  const save = useCommerceMutation({
    mutationFn: () => {
      const input = { name: name.trim(), description: description.trim() || null };
      return category ? api.categories.update(category.id, input) : api.categories.create(input);
    },
    success: t('commerce.common.saved'),
    onSuccess: onClose,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) save.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>
              {category ? t('commerce.categories.edit') : t('commerce.categories.new')}
            </DialogTitle>
          </DialogHeader>
          <FormField label={t('commerce.field.name')}>
            {(id) => (
              <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            )}
          </FormField>
          <FormField label={t('commerce.field.description')}>
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
