import type { AdEntity, AdPlatform, OutboundConversionJob } from '@amable/api-types';
import { ProviderError } from './errors';
import { assertSpendQuery } from './http';
import type {
  AdAccountInfo,
  AdSpendRow,
  AdsProvider,
  SendConversionOptions,
  SpendQuery,
} from './types';

export interface FakeSentConversion {
  readonly accessToken: string;
  readonly job: OutboundConversionJob;
  readonly options: SendConversionOptions;
}

/** Deterministic in-memory provider for dev and tests: same seed → same accounts, entities and spend. */
export interface FakeAdsProvider extends AdsProvider {
  /** Conversions accepted by `sendConversion`, in call order. */
  readonly sent: FakeSentConversion[];
  /** Makes the next `sendConversion` calls throw these errors, one per call. */
  failNext(...errors: ProviderError[]): void;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function* days(from: string, to: string): Generator<string> {
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    yield new Date(t).toISOString().slice(0, 10);
  }
}

const CAMPAIGNS = 2;
const ADSETS_PER_CAMPAIGN = 2;
const ADS_PER_ADSET = 2;

export function createFakeProvider(
  platform: AdPlatform,
  seed: string | number = 'dev',
): FakeAdsProvider {
  const tag = `${platform}-${String(seed)}`;
  const accountId = `fake-${tag}`;
  const currency = 'EUR';
  const sent: FakeSentConversion[] = [];
  const failures: ProviderError[] = [];
  let tokenSerial = 0;

  const entities: AdEntity[] = [];
  for (let c = 1; c <= CAMPAIGNS; c++) {
    const campaignId = `${tag}-c${String(c)}`;
    entities.push({
      platform,
      level: 'campaign',
      external_id: campaignId,
      parent_external_id: null,
      name: `Campaign ${String(c)}`,
      status: c === CAMPAIGNS ? 'paused' : 'active',
      budget_minor: 1000 + (fnv1a(campaignId) % 9000),
    });
    for (let s = 1; s <= ADSETS_PER_CAMPAIGN; s++) {
      const adsetId = `${campaignId}-s${String(s)}`;
      entities.push({
        platform,
        level: 'adset',
        external_id: adsetId,
        parent_external_id: campaignId,
        name: `Campaign ${String(c)} / Ad set ${String(s)}`,
        status: 'active',
        budget_minor: null,
      });
      for (let a = 1; a <= ADS_PER_ADSET; a++) {
        entities.push({
          platform,
          level: 'ad',
          external_id: `${adsetId}-a${String(a)}`,
          parent_external_id: adsetId,
          name: `Campaign ${String(c)} / Ad set ${String(s)} / Ad ${String(a)}`,
          status: 'active',
        });
      }
    }
  }

  function issueTokens() {
    tokenSerial++;
    return {
      accessToken: `fake-access-${tag}-${String(tokenSerial)}`,
      refreshToken: `fake-refresh-${tag}`,
      expiresAt: Date.UTC(2100, 0, 1),
    };
  }

  return {
    platform,
    sent,

    failNext(...errors) {
      failures.push(...errors);
    },

    authorizeUrl({ redirectUri, state }) {
      const url = new URL(redirectUri);
      url.searchParams.set('code', `fake-code-${tag}`);
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchangeCode({ code }) {
      if (code === '') throw new ProviderError('permanent', 'fake: empty code');
      return issueTokens();
    },

    async refreshToken(refreshToken) {
      if (refreshToken !== `fake-refresh-${tag}`)
        throw new ProviderError('auth_expired', 'fake: unknown refresh token');
      return issueTokens();
    },

    async listAccounts(): Promise<AdAccountInfo[]> {
      return [
        {
          account_id: accountId,
          name: `Fake ${platform} account`,
          currency,
          timezone: 'Europe/Rome',
        },
      ];
    },

    async listEntities(): Promise<AdEntity[]> {
      return entities.map((e) => ({ ...e }));
    },

    async fetchSpend(_token, account, query: SpendQuery): Promise<AdSpendRow[]> {
      assertSpendQuery(query);
      const out: AdSpendRow[] = [];
      for (const entity of entities) {
        if (entity.level !== query.level) continue;
        for (const day of days(query.from, query.to)) {
          const h = fnv1a(`${account}|${entity.external_id}|${day}`);
          const spend = 500 + (h % 20_000);
          const conversions = h % 7;
          const base = {
            platform,
            entity_external_id: entity.external_id,
            day,
            currency,
            reported_conversions: conversions,
          };
          if (query.granularity === 'day') {
            out.push({
              ...base,
              spend_minor: spend,
              clicks: 10 + (h % 300),
              impressions: 1000 + (h % 30_000),
              reported_revenue_minor: conversions * (2000 + (h % 5000)),
            });
            continue;
          }
          for (let hour = 0; hour < 24; hour++) {
            const hh = fnv1a(`${String(h)}|${String(hour)}`);
            out.push({
              ...base,
              hour,
              spend_minor: Math.floor(spend / 24) + (hh % 10),
              clicks: hh % 15,
              impressions: 40 + (hh % 1200),
              reported_conversions: hour === h % 24 ? conversions : 0,
              reported_revenue_minor: hour === h % 24 ? conversions * (2000 + (h % 5000)) : 0,
            });
          }
        }
      }
      return out;
    },

    async sendConversion(accessToken, job, options) {
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      sent.push({ accessToken, job, options });
      return { ok: true, platformResponseId: `fake-${tag}-${String(sent.length)}` };
    },
  };
}
