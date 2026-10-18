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
  {
    id: 3,
    name: 'analytics_funnels_ads',
    statements: [
      // --- funnel graphs (current version + immutable history) and traffic sources
      `CREATE TABLE funnel_graphs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        group_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        version INTEGER NOT NULL,
        graph TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      )`,
      `CREATE INDEX funnel_graphs_status ON funnel_graphs (status, updated_at)`,
      `CREATE TABLE funnel_graph_versions (
        funnel_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        graph TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (funnel_id, version)
      )`,
      `CREATE TABLE traffic_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT,
        template TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        config TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      )`,
      `CREATE INDEX traffic_sources_status ON traffic_sources (status, updated_at)`,
      // --- immutable funnel click-log; anonymous rows expire after 90 days
      `CREATE TABLE touches (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        visitor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        funnel_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        page_id TEXT,
        traffic_source_id TEXT,
        kind TEXT NOT NULL,
        action_number INTEGER,
        campaign TEXT,
        external_click_id TEXT,
        fields TEXT,
        cost_minor INTEGER,
        identified INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX touches_visitor ON touches (visitor_id, ts)`,
      `CREATE INDEX touches_funnel ON touches (funnel_id, ts)`,
      `CREATE INDEX touches_source ON touches (traffic_source_id, ts) WHERE traffic_source_id IS NOT NULL`,
      `CREATE INDEX touches_click_id ON touches (external_click_id) WHERE external_click_id IS NOT NULL`,
      `CREATE INDEX touches_session ON touches (session_id, ts)`,
      `CREATE INDEX touches_anonymous ON touches (ts) WHERE identified = 0`,
      // --- identity graph
      `CREATE TABLE identity_keys (
        key_type TEXT NOT NULL,
        key_value TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        UNIQUE (key_type, key_value, visitor_id)
      )`,
      `CREATE INDEX identity_keys_key ON identity_keys (key_type, key_value)`,
      `CREATE INDEX identity_keys_visitor ON identity_keys (visitor_id)`,
      `CREATE TABLE visitor_merges (
        child_visitor_id TEXT NOT NULL,
        origin_visitor_id TEXT NOT NULL,
        mechanism TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (child_visitor_id, origin_visitor_id)
      )`,
      `CREATE INDEX visitor_merges_origin ON visitor_merges (origin_visitor_id)`,
      `CREATE TABLE visitor_tags (
        visitor_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (visitor_id, tag)
      )`,
      `CREATE INDEX visitor_tags_tag ON visitor_tags (tag)`,
      `CREATE TABLE identity_blacklist (
        key_type TEXT NOT NULL,
        key_value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (key_type, key_value)
      )`,
      // --- ad platforms (OAuth tokens stay in the core)
      `CREATE TABLE ad_connections (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_name TEXT,
        currency TEXT,
        status TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        last_sync_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX ad_connections_account ON ad_connections (platform, account_id)`,
      `CREATE TABLE ad_entities (
        platform TEXT NOT NULL,
        external_id TEXT NOT NULL,
        level TEXT NOT NULL,
        parent_external_id TEXT,
        connection_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        budget_minor INTEGER,
        updated_at INTEGER NOT NULL,
        UNIQUE (platform, external_id)
      )`,
      `CREATE INDEX ad_entities_parent ON ad_entities (platform, parent_external_id) WHERE parent_external_id IS NOT NULL`,
      `CREATE TABLE ad_spend_daily (
        platform TEXT NOT NULL,
        entity_external_id TEXT NOT NULL,
        day TEXT NOT NULL,
        connection_id TEXT,
        spend_minor INTEGER NOT NULL,
        currency TEXT,
        clicks INTEGER,
        impressions INTEGER,
        reported_conversions REAL,
        reported_revenue_minor INTEGER,
        updated_at INTEGER NOT NULL,
        UNIQUE (platform, entity_external_id, day)
      )`,
      `CREATE INDEX ad_spend_daily_day ON ad_spend_daily (day)`,
      // --- conversions sent to the platforms (retry queue) and received by postback
      `CREATE TABLE outbound_conversions (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at INTEGER,
        sent_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX outbound_conversions_due ON outbound_conversions (status, next_attempt_at)`,
      `CREATE INDEX outbound_conversions_created ON outbound_conversions (created_at)`,
      `CREATE TABLE conversion_log (
        id TEXT PRIMARY KEY,
        hit TEXT NOT NULL,
        tx TEXT NOT NULL DEFAULT '',
        event TEXT NOT NULL DEFAULT 'sale',
        status TEXT NOT NULL DEFAULT 'approved',
        revenue_minor INTEGER NOT NULL DEFAULT 0,
        currency TEXT,
        ts INTEGER NOT NULL,
        visitor_id TEXT,
        session_id TEXT,
        funnel_id TEXT,
        node_id TEXT,
        page_id TEXT,
        traffic_source_id TEXT,
        source TEXT NOT NULL DEFAULT 'postback',
        data TEXT,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (hit, event, tx)
      )`,
      `CREATE INDEX conversion_log_ts ON conversion_log (ts)`,
      `CREATE INDEX conversion_log_visitor ON conversion_log (visitor_id, ts) WHERE visitor_id IS NOT NULL`,
      `CREATE INDEX conversion_log_funnel ON conversion_log (funnel_id, ts) WHERE funnel_id IS NOT NULL`,
    ],
  },
  {
    id: 4,
    name: 'analytics_funnel_sessions',
    statements: [
      // Routing state of a visitor in a funnel (current page, rotator history) and
      // the tracking fields captured at its entrance. Never holds data-buffer params.
      `CREATE TABLE funnel_sessions (
        visitor_id TEXT NOT NULL,
        funnel_id TEXT NOT NULL,
        current_node_id TEXT,
        current_page_id TEXT,
        rotations TEXT NOT NULL DEFAULT '{}',
        traffic_source_id TEXT,
        campaign TEXT,
        external_click_id TEXT,
        fields TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (visitor_id, funnel_id)
      )`,
      `CREATE INDEX funnel_sessions_recent ON funnel_sessions (visitor_id, updated_at)`,
      `CREATE INDEX funnel_sessions_updated ON funnel_sessions (updated_at)`,
    ],
  },
];
