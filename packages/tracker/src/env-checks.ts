const BOT_UA_RE =
  /bot|crawl|spider|slurp|headless|phantom|selenium|puppeteer|playwright|lighthouse|pagespeed|prerender|scrapy|python-requests|curl\/|wget/i;

/** Client-side automation/bot heuristics: webdriver flag, headless UAs, automation globals. */
export function isLikelyBot(win: Window): boolean {
  const nav = win.navigator;
  if (nav.webdriver === true) return true;
  if (BOT_UA_RE.test(nav.userAgent)) return true;
  const w = win as unknown as Record<string, unknown>;
  return (
    w['_phantom'] !== undefined ||
    w['callPhantom'] !== undefined ||
    w['__nightmare'] !== undefined ||
    w['domAutomation'] !== undefined ||
    w['domAutomationController'] !== undefined
  );
}

export function isLocalHost(loc: Location): boolean {
  const h = loc.hostname;
  return (
    loc.protocol === 'file:' ||
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '127.0.0.1' ||
    h === '[::1]' ||
    h === '::1' ||
    h === '0.0.0.0'
  );
}

export function isInIframe(win: Window): boolean {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}

/** localStorage flag that excludes this browser from tracking. */
export const OPT_OUT_KEY = 'amable_ignore';

export function isOptedOut(win: Window): boolean {
  try {
    return win.localStorage.getItem(OPT_OUT_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setOptOut(win: Window, value: boolean): void {
  try {
    if (value) win.localStorage.setItem(OPT_OUT_KEY, 'true');
    else win.localStorage.removeItem(OPT_OUT_KEY);
  } catch {
    // storage disabled: nothing to persist
  }
}
