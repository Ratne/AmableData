import type { CrawlerSnippets, Site, SiteSnippet } from '@amable/api-types';

/**
 * Server-side snippets reporting crawlers (AI assistants, training and search
 * bots never run the browser tracker) to `POST /e/server` with the site secret.
 * Each forwards only user agent, client IP and URL, and never blocks the page:
 * the report is fire-and-forget with a short timeout.
 */

const SECRET_PLACEHOLDER = 'amb_sk_REPLACE_WITH_SITE_SECRET';

const BOT_PATTERN =
  'bot|crawl|spider|slurp|GPTBot|ChatGPT-User|OAI-SearchBot|Claude|Perplexity|Bytespider|CCBot|Amazonbot|Applebot|cohere|Diffbot|facebookexternalhit|Google-Extended|Meta-External';

export function crawlerSnippets(endpoint: string): CrawlerSnippets {
  const worker = `// Cloudflare Worker (route in front of your site) — reports crawler visits to amabledata.
const AMABLE_ENDPOINT = ${JSON.stringify(endpoint)};
const AMABLE_SECRET = '${SECRET_PLACEHOLDER}'; // store it as a secret: env.AMABLE_SECRET
const BOTS = /${BOT_PATTERN}/i;

export default {
  async fetch(request, env, ctx) {
    const ua = request.headers.get('user-agent') || '';
    if (request.method === 'GET' && (ua === '' || BOTS.test(ua))) {
      ctx.waitUntil(
        fetch(AMABLE_ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + (env.AMABLE_SECRET || AMABLE_SECRET),
          },
          body: JSON.stringify({
            type: 'crawler',
            url: request.url,
            user_agent: ua,
            ip: request.headers.get('cf-connecting-ip') || undefined,
          }),
        }).catch(() => {}),
      );
    }
    return fetch(request);
  },
};
`;
  const node = `// Node.js (Express / Connect middleware, Node 18+) — reports crawler visits to amabledata.
const AMABLE_ENDPOINT = ${JSON.stringify(endpoint)};
const AMABLE_SECRET = process.env.AMABLE_SECRET || '${SECRET_PLACEHOLDER}';
const BOTS = /${BOT_PATTERN}/i;

function amableCrawlers(req, res, next) {
  const ua = req.headers['user-agent'] || '';
  if (req.method === 'GET' && (ua === '' || BOTS.test(ua))) {
    const url = (req.protocol || 'https') + '://' + req.get('host') + req.originalUrl;
    fetch(AMABLE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + AMABLE_SECRET },
      body: JSON.stringify({ type: 'crawler', url, user_agent: ua, ip: req.ip }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  }
  next();
}

module.exports = amableCrawlers; // app.use(amableCrawlers)
`;
  const php = `<?php
// PHP (include at the top of index.php) — reports crawler visits to amabledata.
const AMABLE_ENDPOINT = ${JSON.stringify(endpoint)};
$amableSecret = getenv('AMABLE_SECRET') ?: '${SECRET_PLACEHOLDER}';
$ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET' && ($ua === '' || preg_match('/${BOT_PATTERN}/i', $ua))) {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $payload = json_encode([
        'type' => 'crawler',
        'url' => $scheme . '://' . ($_SERVER['HTTP_HOST'] ?? '') . ($_SERVER['REQUEST_URI'] ?? '/'),
        'user_agent' => $ua,
        'ip' => $_SERVER['HTTP_CF_CONNECTING_IP'] ?? ($_SERVER['REMOTE_ADDR'] ?? null),
    ]);
    $ch = curl_init(AMABLE_ENDPOINT);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $payload,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $amableSecret],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT_MS => 800,
    ]);
    curl_exec($ch);
    curl_close($ch);
}
`;
  return { endpoint, secret_placeholder: SECRET_PLACEHOLDER, worker, node, php };
}

/**
 * Reverse-proxy recipes: the site serves `/<dir>/*` from its own host and
 * forwards it to the edge, so the tracker is first party without a DNS change.
 * Only the tracker's own cookie is forwarded; the client IP, host and location
 * travel in `x-amb-*` headers that the edge trusts only with the site's proxy
 * key (`proxyKey`, null when the installation has no gateway secret).
 */
export function proxyRecipes(
  site: Pick<Site, 'script_path' | 'cookieless'>,
  origin: string,
  proxyKey: string | null,
): SiteSnippet['proxy'] {
  const dir = site.script_path.split('/')[0] ?? site.script_path;
  const edgeHost = new URL(origin).host;
  const cookie = 'amb_vid';
  const script = `/${site.script_path}${site.cookieless ? '-l' : ''}.js`;
  const key = proxyKey ?? 'KEY-UNAVAILABLE-SET-EDGE_GATEWAY_SECRET';
  const cloudflare = `// Cloudflare Worker on the route  <your-domain>/${dir}/*
const UPSTREAM = ${JSON.stringify(origin)};
const PROXY_KEY = ${JSON.stringify(key)};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    const vid = (request.headers.get('cookie') || '').match(/(?:^|;\\s*)${cookie}=([^;]+)/);
    headers.delete('cookie');
    if (vid) headers.set('cookie', '${cookie}=' + vid[1]);
    const cf = request.cf || {};
    headers.set('x-amb-proxy-key', PROXY_KEY);
    headers.set('x-amb-forwarded-for', request.headers.get('cf-connecting-ip') || '');
    headers.set('x-amb-forwarded-host', url.hostname);
    if (cf.country) headers.set('x-amb-geo-country', cf.country);
    if (cf.region) headers.set('x-amb-geo-region', encodeURIComponent(cf.region));
    if (cf.city) headers.set('x-amb-geo-city', encodeURIComponent(cf.city));
    return fetch(UPSTREAM + url.pathname + url.search, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? request.body : undefined,
    });
  },
};

// Page tag: <script defer data-site="…" src="${script}"></script>
`;
  const nginx = `# nginx — the location is the one of your server, not of the visitor (no geo headers):
# put the Worker recipe in front when you need visitor countries and cities.
# Behind a load balancer or CDN, set real_ip_header / set_real_ip_from first,
# otherwise $remote_addr is the balancer's address.
map $cookie_${cookie} $amb_cookie {
  ""      "";
  default "${cookie}=$cookie_${cookie}";
}

# (server block of your site)
location /${dir}/ {
  proxy_pass ${origin}/${dir}/;
  proxy_set_header Host ${edgeHost};
  proxy_ssl_server_name on;
  proxy_set_header Cookie $amb_cookie;
  proxy_set_header X-SA-Proxy-Key "${key}";
  proxy_set_header X-SA-Forwarded-For $remote_addr;
  proxy_set_header X-SA-Forwarded-Host $host;
}

# Page tag: <script defer data-site="…" src="${script}"></script>
`;
  const next = `// next.config.js — rewrites cannot add headers: visitor IP and location are those of
// the hosting server and the sessions count as third party. Prefer the Worker or
// nginx recipe when they are an option.
module.exports = {
  async rewrites() {
    return [{ source: '/${dir}/:path*', destination: '${origin}/${dir}/:path*' }];
  },
};
`;
  const vercel = `// vercel.json (same limits as the Next.js rewrite)
{
  "rewrites": [{ "source": "/${dir}/:path*", "destination": "${origin}/${dir}/:path*" }]
}
`;
  return { path: `/${dir}/`, cloudflare, nginx, next, vercel };
}
