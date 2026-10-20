import type { Contact, CustomFieldValueInput } from '@amable/api-types/crm';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@amable/ui/ui/tabs';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { Permission } from '@amable/core';
import { useEffect, useRef, type ReactNode } from 'react';
import { useI18n } from '../../../../i18n';
import { useCrm, useCustomFieldLayout, usePermissions } from '../../api/hooks';
import { useContactCounts } from '../../api/contact-tabs';
import { ErrorNotice } from '../../components/states';
import { customFieldTabsOf, CustomFieldsSection } from '../../custom-fields/custom-fields-panel';
import {
  CONTACT_TABS,
  isCustomFieldTab,
  type ContactDetailSearch,
  type ContactTab,
  type CustomFieldContactTab,
  type FixedContactTab,
} from '../../routes';
import type { SaveContact } from './marketing';

const UNGROUPED_TAB: CustomFieldContactTab = 'cf:other';

/** One custom field layout tab (`cf:<id>`) or the ungrouped fields (`cf:other`). */
export function CustomFieldsTab({
  tab,
  contact,
  canEdit,
  save,
}: {
  tab: CustomFieldContactTab;
  contact: Contact;
  canEdit: boolean;
  save: SaveContact;
}) {
  const { can } = usePermissions();
  const layout = useCustomFieldLayout('contacts');
  if (layout.error) return <ErrorNotice error={layout.error} />;
  if (!layout.data) return <Skeleton className="h-24 w-full" />;
  return (
    <CustomFieldsSection
      layout={layout.data}
      tabId={tab === UNGROUPED_TAB ? null : tab.slice(3)}
      values={contact.custom_fields}
      canEdit={canEdit}
      canReadSensitive={can('contacts:read_sensitive')}
      onSave={(key: string, value: CustomFieldValueInput) =>
        save({ custom_fields: { [key]: value } })
      }
    />
  );
}

/** Custom field layout tabs shown next to the fixed ones (layout is reference data, cached). */
function useCustomFieldTabs(): { readonly id: CustomFieldContactTab; readonly label: string }[] {
  const { t } = useI18n();
  const layout = useCustomFieldLayout('contacts').data;
  if (!layout) return [];
  const tabs = customFieldTabsOf(layout).map((tab) => ({
    id: `cf:${tab.id}` as const,
    label: tab.name,
  }));
  return layout.ungrouped.length > 0
    ? [...tabs, { id: UNGROUPED_TAB, label: t('crm.customFields.other') }]
    : tabs;
}

/** Permission needed to see a tab (none: every reader of the contact). */
const TAB_PERMISSION: Partial<Record<FixedContactTab, Permission>> = {
  tasks: 'tasks:read',
  appointments: 'tasks:read',
  deals: 'opportunities:read',
  orders: 'orders:read',
  signatures: 'esign:read',
  submissions: 'forms:read',
  automations: 'automations:read',
  journey: 'analytics:journey_read',
};

/**
 * Tab strip of the contact page: only the open tab is mounted, so each panel
 * fetches its data when first opened; `?tab=` keeps the choice in the URL.
 */
export function ContactTabs({
  contactId,
  children,
  customField,
}: {
  contactId: string;
  children: Readonly<Record<FixedContactTab, ReactNode>>;
  customField: (tab: CustomFieldContactTab) => ReactNode;
}) {
  const { t } = useI18n();
  const { can, ready } = usePermissions();
  const { slug } = useCrm();
  const navigate = useNavigate();
  const search: ContactDetailSearch = useSearch({ strict: false });
  const counts = useContactCounts(contactId).data;
  const customTabs = useCustomFieldTabs();
  const fixed = CONTACT_TABS.filter((tab) => {
    const permission = TAB_PERMISSION[tab];
    return permission === undefined || can(permission);
  });
  const visible: { readonly id: ContactTab; readonly label: string }[] = [
    ...fixed.map((id) => ({ id, label: t(`crm.contact.tab.${id}`) })),
    ...customTabs,
  ];
  const requested = search.tab;
  const active: ContactTab =
    requested !== undefined &&
    (visible.some((tab) => tab.id === requested) ||
      (requested.startsWith('cf:') && customTabs.length === 0))
      ? requested
      : 'activity';
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = strip.current;
    const trigger = scroller?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (!scroller || !trigger) return;
    const left =
      trigger.getBoundingClientRect().left -
      scroller.getBoundingClientRect().left +
      scroller.scrollLeft;
    if (
      left < scroller.scrollLeft ||
      left + trigger.offsetWidth > scroller.scrollLeft + scroller.clientWidth
    ) {
      scroller.scrollLeft = left - 16;
    }
  }, [active, ready]);
  const countOf: Partial<Record<FixedContactTab, number | undefined>> = {
    tags: counts?.tags,
    notes: counts?.notes,
    tasks: counts?.tasks_open,
    appointments: counts?.appointments,
    deals: counts?.opportunities,
    orders: counts?.orders,
    submissions: counts?.submissions,
    emails: counts?.emails,
    signatures: counts?.signatures,
  };
  /** Text and tooltip of the badge next to a tab label (none when there is nothing to count). */
  const badgeOf = (tab: FixedContactTab): { text: string; title?: string } | null => {
    if (tab === 'automations') {
      const active = counts?.automations_active;
      const total = counts?.automations_total;
      if (active === undefined || total === undefined || total === 0) return null;
      return {
        text: active === total ? String(active) : `${String(active)}/${String(total)}`,
        title: t('crm.contactAutomations.countTitle', { active, total }),
      };
    }
    const count = countOf[tab];
    return count === undefined || count === 0 ? null : { text: String(count) };
  };
  return (
    <div className="min-w-0 rounded-xl border bg-card p-4">
      <Tabs
        value={active}
        onValueChange={(value) =>
          void navigate({
            to: '/t/$tenant/contacts/$contactId',
            params: { tenant: slug, contactId },
            search: value === 'activity' ? {} : { tab: value as ContactTab },
            replace: true,
            resetScroll: false,
          })
        }
      >
        <div ref={strip} className="-mx-4 overflow-x-auto px-4 pb-1 [scrollbar-width:thin]">
          <TabsList className="w-max" aria-label={t('crm.contact.tabsLabel')}>
            {visible.map(({ id, label }) => {
              const badge = id.startsWith('cf:') ? null : badgeOf(id as FixedContactTab);
              return (
                <TabsTrigger key={id} value={id} className="flex-none">
                  {label}
                  {badge !== null ? (
                    <span
                      className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums"
                      title={badge.title}
                    >
                      {badge.text}
                    </span>
                  ) : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>
        <TabsContent value={active} className="pt-3">
          {!ready ? (
            <Skeleton className="h-24 w-full" />
          ) : isCustomFieldTab(active) ? (
            customField(active)
          ) : (
            children[active]
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
