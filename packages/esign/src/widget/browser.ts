import type { SigningBrowserFacts } from '../types';

/** Device and browser facts recorded with every signing action (evidence of who signed and how). */

function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )}${sign}${pad(abs / 60)}:${pad(abs % 60)}`;
}

export function collectBrowser(): SigningBrowserFacts {
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string } };
  const facts: SigningBrowserFacts = { local_time: localIso(new Date()) };
  try {
    facts.time_zone = Intl.DateTimeFormat().resolvedOptions().timeZone.slice(0, 64);
  } catch {
    // no Intl time zone support
  }
  facts.languages = Array.from(nav.languages ?? [nav.language]).slice(0, 10).map((l) => l.slice(0, 35));
  const platform = nav.userAgentData?.platform ?? nav.platform;
  if (platform !== undefined && platform !== '') facts.platform = platform.slice(0, 100);
  facts.screen = `${String(screen.width)}x${String(screen.height)}`;
  facts.viewport = `${String(window.innerWidth)}x${String(window.innerHeight)}`;
  facts.pixel_ratio = Math.round((window.devicePixelRatio || 1) * 100) / 100;
  facts.color_depth = screen.colorDepth;
  facts.touch_points = nav.maxTouchPoints ?? 0;
  if (nav.hardwareConcurrency !== undefined) facts.hardware_concurrency = nav.hardwareConcurrency;
  if (nav.deviceMemory !== undefined) facts.device_memory = nav.deviceMemory;
  facts.cookies_enabled = nav.cookieEnabled;
  if (nav.doNotTrack !== null && nav.doNotTrack !== undefined) facts.do_not_track = nav.doNotTrack.slice(0, 10);
  facts.webdriver = nav.webdriver === true;
  if (document.referrer !== '') facts.referrer = document.referrer.slice(0, 2048);
  return facts;
}
