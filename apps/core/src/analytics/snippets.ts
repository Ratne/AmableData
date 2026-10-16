import type { CrawlerSnippets } from '@amable/api-types';

/**
 * Server-side snippets reporting crawlers (AI assistants, training and search
 * bots never run the browser tracker) to `POST /e/server` with the site secret.
 * Each forwards only user agent, client IP and URL, and never blocks the page:
 * the report is fire-and-forget with a short timeout.
 */

export const SECRET_PLACEHOLDER = 'amb_sk_REPLACE_WITH_SITE_SECRET';

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
