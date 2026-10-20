import type {
  BillingEmailQuota,
  BillingOverview,
  BillingWallet,
  ServiceState,
} from '@amable/api-types';
import { formatDateTime, formatNumber, type Locale, type MessageKey } from '@amable/i18n';
import { PageBody, usePageChrome } from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Button } from '@amable/ui/ui/button';
import { Progress } from '@amable/ui/ui/progress';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, ExternalLink, Info, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { Facts, Pill, SectionCard } from '../../../components/feature-kit';
import { PageState } from '../../commerce/components/common';
import { request } from '../../../lib/tenant-api';
import { usePermissions, useTenantSlug } from '../../crm/api/hooks';

/** Low-balance threshold: the wallet should cover at least this many emails beyond the quota. */
const LOW_BALANCE_EMAILS = 1000;

const STATE_TONE: Record<ServiceState, Parameters<typeof Pill>[0]['tone']> = {
  trial: 'info',
  active: 'success',
  grace: 'warning',
  suspended: 'danger',
  self_hosted: 'neutral',
};

const STATE_KEY: Record<ServiceState, MessageKey> = {
  trial: 'billing.state.trial',
  active: 'billing.state.active',
  grace: 'billing.state.grace',
  suspended: 'billing.state.suspended',
  self_hosted: 'billing.state.self_hosted',
};

function money(locale: Locale, amount: number, currency: string): string {
  return formatNumber(locale, amount, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
  });
}

/** List prices: "99 $", "1 $" — cents only when the price has them. */
function price(locale: Locale, amount: number, currency: string): string {
  return formatNumber(locale, amount, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  });
}

function day(locale: Locale, iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : formatDateTime(locale, ms, undefined, { dateStyle: 'medium' });
}

function PortalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={href} target="_blank" rel="noopener">
        {children}
        <ExternalLink aria-hidden />
      </a>
    </Button>
  );
}

export function BillingPage() {
  const { t } = useI18n();
  const slug = useTenantSlug();
  const { can, ready } = usePermissions();
  usePageChrome({ title: t('billing.title') });
  const allowed = ready && can('tenant:billing');
  const overview = useQuery({
    queryKey: ['tenant', slug, 'billing'] as const,
    queryFn: () => request<BillingOverview>(`/api/v2/t/${encodeURIComponent(slug)}/billing`),
    enabled: allowed,
  });

  if (ready && !allowed) {
    return (
      <PageBody className="max-w-3xl pt-4">
        <Alert>
          <ShieldAlert aria-hidden />
          <AlertDescription>{t('billing.ownerOnly')}</AlertDescription>
        </Alert>
      </PageBody>
    );
  }
  return (
    <PageState isPending={!ready || overview.isPending} error={overview.error}>
      {() => (overview.data ? <BillingView data={overview.data} /> : null)}
    </PageState>
  );
}

function BillingView({ data }: { data: BillingOverview }) {
  return (
    <PageBody className="grid max-w-3xl gap-4 pt-4">
      <SnapshotNotice data={data} />
      {data.mode === 'managed' ? (
        <>
          <PlanCard data={data} />
          <EmailCard email={data.email} capacityUrl={data.portal.capacity_url} />
          <WalletCard wallet={data.wallet} email={data.email} portal={data.portal} />
        </>
      ) : (
        <>
          <OpenSourceCard data={data} />
          {data.linked ? (
            <WalletCard wallet={data.wallet} email={null} portal={data.portal} />
          ) : null}
        </>
      )}
    </PageBody>
  );
}

function SnapshotNotice({ data }: { data: BillingOverview }) {
  const { t, locale } = useI18n();
  if (data.snapshot.status === 'stale' && data.snapshot.issued_at !== null) {
    const issued = Date.parse(data.snapshot.issued_at);
    return (
      <Alert>
        <CircleAlert aria-hidden />
        <AlertTitle>{t('billing.stale.title')}</AlertTitle>
        <AlertDescription>
          {t('billing.stale.body', {
            date: Number.isNaN(issued) ? data.snapshot.issued_at : formatDateTime(locale, issued),
          })}
        </AlertDescription>
      </Alert>
    );
  }
  if (data.linked && data.snapshot.status === 'missing') {
    return (
      <Alert>
        <Info aria-hidden />
        <AlertDescription>{t('billing.missing.body')}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

function PlanCard({ data }: { data: BillingOverview }) {
  const { t, locale } = useI18n();
  const state = data.service_state;
  return (
    <SectionCard title={t('billing.plan.title')}>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-lg font-semibold">{t('billing.plan.managed')}</span>
          {data.plan ? (
            <span className="text-muted-foreground">
              {t('billing.plan.managedPrice', {
                price: price(locale, data.plan.price_monthly, data.plan.currency),
              })}
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{t('billing.plan.managedBody')}</p>
        <Facts
          rows={[
            [
              t('billing.plan.state'),
              state === null ? (
                <span className="text-muted-foreground">{t('billing.plan.unknownState')}</span>
              ) : (
                <Pill tone={STATE_TONE[state]}>{t(STATE_KEY[state])}</Pill>
              ),
            ],
            ...(data.email
              ? [[t('billing.plan.periodEnd'), day(locale, data.email.period_end)] as const]
              : []),
          ]}
        />
        {state === 'grace' || state === 'suspended' ? (
          <Alert variant={state === 'suspended' ? 'destructive' : 'default'}>
            <TriangleAlert aria-hidden />
            <AlertTitle>{t(STATE_KEY[state])}</AlertTitle>
            <AlertDescription>
              {t(state === 'grace' ? 'billing.state.graceBody' : 'billing.state.suspendedBody')}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    </SectionCard>
  );
}

function EmailCard({ email, capacityUrl }: { email: BillingEmailQuota | null; capacityUrl: string }) {
  const { t, locale } = useI18n();
  if (email === null) {
    return (
      <SectionCard title={t('billing.email.title')}>
        <p className="text-sm text-muted-foreground">{t('billing.email.unavailable')}</p>
      </SectionCard>
    );
  }
  const num = (value: number) => formatNumber(locale, value);
  const used = Math.min(email.used_this_period, email.included_monthly);
  const percent = email.included_monthly > 0 ? (used / email.included_monthly) * 100 : 100;
  const overage = price(locale, email.overage_per_1000, email.currency);
  const cap = (value: number | null) => (value === null ? t('billing.email.noCap') : num(value));
  return (
    <SectionCard title={t('billing.email.title')}>
      <div className="grid gap-4">
        <div className="grid gap-2">
          <p className="text-sm">
            {t('billing.email.used', { used: num(used), included: num(email.included_monthly) })}
          </p>
          <Progress value={percent} aria-label={t('billing.email.title')} />
        </div>
        <Facts
          rows={[
            [t('billing.email.remaining'), num(email.remaining)],
            [
              t('billing.email.period'),
              t('billing.email.periodRange', {
                start: day(locale, email.period_start),
                end: day(locale, email.period_end),
              }),
            ],
            [t('billing.email.overage'), t('billing.email.overagePrice', { price: overage })],
            ...(email.caps.hourly !== null || email.caps.daily !== null
              ? [
                  [
                    t('billing.email.caps'),
                    t('billing.email.capsValue', {
                      hourly: cap(email.caps.hourly),
                      daily: cap(email.caps.daily),
                    }),
                  ] as const,
                ]
              : []),
          ]}
        />
        <p className="text-sm text-muted-foreground">
          {t('billing.email.explain', { price: overage })}
        </p>
        <div>
          <PortalLink href={capacityUrl}>{t('billing.email.increase')}</PortalLink>
        </div>
      </div>
    </SectionCard>
  );
}

function WalletCard({
  wallet,
  email,
  portal,
}: {
  wallet: BillingWallet | null;
  email: BillingEmailQuota | null;
  portal: BillingOverview['portal'];
}) {
  const { t, locale } = useI18n();
  const lowCost = email === null ? null : (email.overage_per_1000 * LOW_BALANCE_EMAILS) / 1000;
  const low = wallet !== null && lowCost !== null && lowCost > 0 && wallet.balance < lowCost;
  return (
    <SectionCard title={t('billing.wallet.title')}>
      <div className="grid gap-4">
        {wallet === null ? (
          <p className="text-sm text-muted-foreground">{t('billing.wallet.unavailable')}</p>
        ) : (
          <div className="grid gap-1">
            <span className="text-sm text-muted-foreground">{t('billing.wallet.balance')}</span>
            <span className="text-3xl font-semibold tabular-nums">
              {money(locale, wallet.balance, wallet.currency)}
            </span>
          </div>
        )}
        {low && wallet !== null && lowCost !== null ? (
          <Alert>
            <TriangleAlert aria-hidden />
            <AlertTitle>{t('billing.wallet.lowTitle')}</AlertTitle>
            <AlertDescription>
              {t('billing.wallet.low', {
                count: formatNumber(locale, LOW_BALANCE_EMAILS),
                cost: price(locale, lowCost, wallet.currency),
              })}
            </AlertDescription>
          </Alert>
        ) : null}
        <p className="text-sm text-muted-foreground">{t('billing.wallet.explain')}</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <a href={portal.wallet_url} target="_blank" rel="noopener">
              {t('billing.wallet.topUp')}
              <ExternalLink aria-hidden />
            </a>
          </Button>
          <PortalLink href={portal.billing_url}>{t('billing.wallet.manage')}</PortalLink>
        </div>
      </div>
    </SectionCard>
  );
}

function OpenSourceCard({ data }: { data: BillingOverview }) {
  const { t } = useI18n();
  return (
    <SectionCard title={t('billing.openSource.title')}>
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-semibold">{t('billing.plan.openSource')}</span>
          {data.service_state ? (
            <Pill tone={STATE_TONE[data.service_state]}>{t(STATE_KEY[data.service_state])}</Pill>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{t('billing.openSource.body')}</p>
        <p className="text-sm text-muted-foreground">
          {t(data.linked ? 'billing.openSource.linked' : 'billing.openSource.connect')}
        </p>
        {data.linked ? null : (
          <div>
            <PortalLink href={data.portal.connect_url}>
              {t('billing.openSource.connectButton')}
            </PortalLink>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
