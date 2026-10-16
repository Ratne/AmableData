import type { Migration } from '@amable/db';

/**
 * Schema of the AnalyticsDO (SQLite), applied at first access by the shared
 * migration runner. Two kinds of instances share it:
 * - `site:<siteId>` — configuration, salts and every analytics table of one site;
 * - `tenant:<tenantId>` — only `tenant_sites`, the list of the tenant's sites.
 *
 * Timestamps are epoch ms; money is in minor units of the site currency.
 * Never edit a shipped migration: append a new one.
 */
export const analyticsMigrations: readonly Migration[] = [
  {
    id: 1,
    name: 'analytics_init',
    statements: [
      `CREATE TABLE analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE TABLE site_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        site_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        hostnames TEXT NOT NULL,
        cookieless INTEGER NOT NULL DEFAULT 0,
        allow_localhost INTEGER NOT NULL DEFAULT 0,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        currency TEXT NOT NULL DEFAULT 'EUR',
        retention_days INTEGER NOT NULL DEFAULT 395,
        secret_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE TABLE daily_salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL, created_at INTEGER NOT NULL)`,
      `CREATE TABLE tenant_sites (site_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`,
      `CREATE TABLE visitors (
        id TEXT PRIMARY KEY,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        session_count INTEGER NOT NULL DEFAULT 0,
        cookieless INTEGER NOT NULL DEFAULT 0,
        user_id TEXT,
        email TEXT,
        name TEXT,
        traits TEXT,
        first_channel TEXT,
        first_source TEXT,
        first_referrer_host TEXT,
        country TEXT,
        device TEXT,
        browser TEXT,
        os TEXT
      )`,
      `CREATE INDEX visitors_email ON visitors (email) WHERE email IS NOT NULL`,
      `CREATE INDEX visitors_user ON visitors (user_id) WHERE user_id IS NOT NULL`,
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        visitor_id TEXT NOT NULL,
        session_number INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        hostname TEXT,
        entry_path TEXT,
        exit_path TEXT,
        referrer TEXT,
        referrer_host TEXT,
        channel TEXT NOT NULL,
        paid INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        utm_term TEXT,
        utm_content TEXT,
        click_ids TEXT,
        country TEXT,
        region TEXT,
        city TEXT,
        latitude REAL,
        longitude REAL,
        device TEXT,
        browser TEXT,
        os TEXT,
        language TEXT,
        pageviews INTEGER NOT NULL DEFAULT 0,
        goals INTEGER NOT NULL DEFAULT 0,
        revenue_minor INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        bounce INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE INDEX sessions_started ON sessions (started_at)`,
      `CREATE INDEX sessions_visitor ON sessions (visitor_id, last_seen)`,
      `CREATE INDEX sessions_last_seen ON sessions (last_seen)`,
      `CREATE TABLE pageviews (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        hostname TEXT NOT NULL,
        path TEXT NOT NULL
      )`,
      `CREATE INDEX pageviews_ts ON pageviews (ts)`,
      `CREATE INDEX pageviews_session ON pageviews (session_id)`,
      `CREATE TABLE goals (
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        visitor_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        name TEXT NOT NULL,
        path TEXT,
        params TEXT
      )`,
      `CREATE INDEX goals_ts ON goals (ts)`,
      `CREATE INDEX goals_name ON goals (name, ts)`,
      `CREATE INDEX goals_session ON goals (session_id)`,
      `CREATE TABLE payments (
        id INTEGER PRIMARY KEY,
        transaction_id TEXT NOT NULL UNIQUE,
        visitor_id TEXT,
        session_id TEXT,
        ts INTEGER NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        email TEXT,
        customer_id TEXT,
        renewal INTEGER NOT NULL DEFAULT 0,
        refunded INTEGER NOT NULL DEFAULT 0,
        free_trial INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX payments_ts ON payments (ts)`,
      `CREATE TABLE exit_links (
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        visitor_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        url TEXT NOT NULL,
        host TEXT NOT NULL,
        path TEXT
      )`,
      `CREATE INDEX exit_links_ts ON exit_links (ts)`,
      `CREATE TABLE bot_hits (
        day TEXT NOT NULL,
        category TEXT NOT NULL,
        provider TEXT NOT NULL,
        bot TEXT NOT NULL,
        path TEXT NOT NULL,
        hits INTEGER NOT NULL,
        PRIMARY KEY (day, category, provider, bot, path)
      )`,
      `CREATE TABLE ingested_events (eid TEXT PRIMARY KEY, ts INTEGER NOT NULL)`,
      `CREATE INDEX ingested_events_ts ON ingested_events (ts)`,
      `CREATE TABLE rollup_hourly (
        bucket INTEGER PRIMARY KEY,
        visitors INTEGER NOT NULL,
        sessions INTEGER NOT NULL,
        pageviews INTEGER NOT NULL,
        bounces INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        goals INTEGER NOT NULL,
        revenue_minor INTEGER NOT NULL
      )`,
      `CREATE TABLE rollup_daily (
        day TEXT PRIMARY KEY,
        start_ts INTEGER NOT NULL,
        visitors INTEGER NOT NULL,
        sessions INTEGER NOT NULL,
        pageviews INTEGER NOT NULL,
        bounces INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        goals INTEGER NOT NULL,
        revenue_minor INTEGER NOT NULL
      )`,
      `CREATE TABLE rollup_dirty (grain TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (grain, key))`,
    ],
  },
  {
    id: 2,
    name: 'analytics_attribution_extras',
    statements: [
      // --- site settings
      `ALTER TABLE site_config ADD COLUMN attribution_model TEXT NOT NULL DEFAULT 'last_non_direct'`,
      `ALTER TABLE site_config ADD COLUMN last_event_at INTEGER`,
      `ALTER TABLE site_config ADD COLUMN last_event_url TEXT`,
      // --- identity: a visitor belongs to at most one CRM contact (many visitors per contact)
      `ALTER TABLE visitors ADD COLUMN contact_id TEXT`,
      `ALTER TABLE visitors ADD COLUMN linked_at INTEGER`,
      `ALTER TABLE visitors ADD COLUMN link_source TEXT`,
      `CREATE INDEX visitors_contact ON visitors (contact_id) WHERE contact_id IS NOT NULL`,
      `CREATE INDEX visitors_last_seen ON visitors (last_seen)`,
      // --- payments: partial refunds and CRM origin
      `ALTER TABLE payments ADD COLUMN refunded_minor INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE payments ADD COLUMN source TEXT NOT NULL DEFAULT 'tracker'`,
      `ALTER TABLE payments ADD COLUMN order_id TEXT`,
      `ALTER TABLE payments ADD COLUMN contact_id TEXT`,
      `CREATE INDEX payments_visitor ON payments (visitor_id, ts)`,
      `CREATE INDEX payments_order ON payments (order_id) WHERE order_id IS NOT NULL`,
      `CREATE INDEX payments_contact ON payments (contact_id) WHERE contact_id IS NOT NULL`,
      `CREATE TABLE payment_refunds (
        refund_key TEXT PRIMARY KEY,
        transaction_id TEXT,
        order_id TEXT,
        amount_minor INTEGER NOT NULL,
        ts INTEGER NOT NULL
      )`,
      `CREATE INDEX goals_visitor ON goals (visitor_id, ts)`,
      `CREATE INDEX pageviews_visitor ON pageviews (visitor_id, ts)`,
      // --- bots: IP verification counters
      `ALTER TABLE bot_hits ADD COLUMN verified_hits INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE bot_hits ADD COLUMN spoofed_hits INTEGER NOT NULL DEFAULT 0`,
      // --- work the core picks up (identity resolution, automation events, goal alerts)
      `CREATE TABLE identity_queue (
        id INTEGER PRIMARY KEY,
        visitor_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        ts INTEGER NOT NULL
      )`,
      `CREATE TABLE automation_queue (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        session_id TEXT,
        name TEXT,
        hostname TEXT,
        path TEXT,
        params TEXT,
        ts INTEGER NOT NULL
      )`,
      `CREATE TABLE alerts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        goal TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        email_recipients TEXT NOT NULL DEFAULT '[]',
        webhook_url TEXT,
        webhook_secret TEXT,
        last_triggered_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX alerts_goal ON alerts (goal) WHERE enabled = 1`,
      `CREATE TABLE alert_queue (
        id INTEGER PRIMARY KEY,
        alert_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        visitor_id TEXT,
        test INTEGER NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL
      )`,
      `CREATE TABLE alert_deliveries (
        id INTEGER PRIMARY KEY,
        alert_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        ok INTEGER NOT NULL,
        ts INTEGER NOT NULL
      )`,
      `CREATE INDEX alert_deliveries_alert ON alert_deliveries (alert_id, ts)`,
      // --- saved views
      `CREATE TABLE funnels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        steps TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE segments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        filters TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      // --- public share links and site API keys (only hashes / ids are stored)
      `CREATE TABLE shares (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_used_at INTEGER
      )`,
      `CREATE TABLE site_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      )`,
      // --- conversion prediction (one model per site, retrained nightly)
      `CREATE TABLE prediction_model (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        trained_at INTEGER NOT NULL,
        model TEXT NOT NULL
      )`,
      // --- ad spend and organic search data (integrations)
      `CREATE TABLE integrations (
        provider TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        account_id TEXT,
        account_name TEXT,
        connected_at INTEGER,
        last_sync_at INTEGER,
        last_error TEXT
      )`,
      `CREATE TABLE ad_spend (
        day TEXT NOT NULL,
        provider TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        campaign_name TEXT NOT NULL,
        spend_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        impressions INTEGER NOT NULL,
        clicks INTEGER NOT NULL,
        PRIMARY KEY (day, provider, campaign_id)
      )`,
      `CREATE TABLE search_stats (
        day TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        clicks INTEGER NOT NULL,
        impressions INTEGER NOT NULL,
        position_weighted REAL NOT NULL,
        PRIMARY KEY (day, kind, key)
      )`,
      // --- tenant:<id> instances: CRM sync cursor and the tenant-wide contact registry
      `CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE TABLE sync_seen (event_id TEXT PRIMARY KEY, ts INTEGER NOT NULL)`,
      `CREATE INDEX sync_seen_ts ON sync_seen (ts)`,
      `CREATE TABLE contact_visitors (
        site_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        linked_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (site_id, visitor_id)
      )`,
      `CREATE INDEX contact_visitors_contact ON contact_visitors (contact_id, linked_at)`,
      `CREATE TABLE dirty_sites (site_id TEXT PRIMARY KEY, ts INTEGER NOT NULL)`,
    ],
  },
];
