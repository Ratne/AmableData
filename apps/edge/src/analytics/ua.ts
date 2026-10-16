/** Lightweight user-agent parsing: browser, OS and device class (no dependency). */

export type DeviceType = 'desktop' | 'mobile' | 'tablet';

export interface ParsedUserAgent {
  browser: string;
  browserVersion: string | null;
  os: string;
  osVersion: string | null;
  device: DeviceType;
}

/** Order matters: Chromium forks advertise "Chrome" and "Safari" too. */
const BROWSERS: ReadonlyArray<[name: string, re: RegExp]> = [
  ['Edge', /\b(?:Edg|EdgA|EdgiOS|Edge)\/(\d+)/],
  ['Opera', /\b(?:OPR|Opera|OPiOS)\/(\d+)/],
  ['Samsung Internet', /\bSamsungBrowser\/(\d+)/],
  ['Yandex', /\bYaBrowser\/(\d+)/],
  ['UC Browser', /\bUCBrowser\/(\d+)/],
  ['Vivaldi', /\bVivaldi\/(\d+)/],
  ['DuckDuckGo', /\bDuckDuckGo\/(\d+)/],
  ['Facebook', /\b(?:FBAV|FBAN)\/?(\d+)?/],
  ['Instagram', /\bInstagram (\d+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /\b(?:Chrome|CriOS|Chromium)\/(\d+)/],
  ['Internet Explorer', /\b(?:MSIE |Trident\/.*rv:)(\d+)/],
  ['Safari', /\bVersion\/(\d+)(?:[.\d]*)? (?:Mobile\/\w+ )?Safari\//],
];

export function parseUserAgent(ua: string): ParsedUserAgent {
  let browser = 'Unknown';
  let browserVersion: string | null = null;
  for (const [name, re] of BROWSERS) {
    const m = re.exec(ua);
    if (m !== null) {
      browser = name;
      browserVersion = m[1] ?? null;
      break;
    }
  }
  if (browser === 'Unknown' && /AppleWebKit/.test(ua) && /Mobile\//.test(ua)) browser = 'Safari';

  let os = 'Unknown';
  let osVersion: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /\bWindows NT (\d+\.\d+)/.exec(ua)) !== null) {
    os = 'Windows';
    osVersion = m[1] === '10.0' ? '10' : (m[1] ?? null);
  } else if ((m = /\biPad.*?OS (\d+)/.exec(ua)) !== null) {
    os = 'iPadOS';
    osVersion = m[1] ?? null;
  } else if ((m = /\b(?:iPhone|iPod).*?OS (\d+)/.exec(ua)) !== null) {
    os = 'iOS';
    osVersion = m[1] ?? null;
  } else if ((m = /\bAndroid (\d+)/.exec(ua)) !== null || /\bAndroid\b/.test(ua)) {
    os = 'Android';
    osVersion = m?.[1] ?? null;
  } else if (/\bCrOS\b/.test(ua)) {
    os = 'ChromeOS';
  } else if ((m = /\bMac OS X (\d+)[._](\d+)/.exec(ua)) !== null) {
    os = 'macOS';
    osVersion = `${m[1]}.${m[2]}`;
  } else if (/\bLinux\b/.test(ua)) {
    os = 'Linux';
  }

  let device: DeviceType = 'desktop';
  if (
    os === 'iPadOS' ||
    /\bTablet\b|\bKindle\b|\bSilk\//.test(ua) ||
    (os === 'Android' && !/\bMobile\b/.test(ua))
  ) {
    device = 'tablet';
  } else if (/\bMobi|\biPhone\b|\biPod\b|\bAndroid.*Mobile\b|\bWindows Phone\b/.test(ua)) {
    device = 'mobile';
  }
  return { browser, browserVersion, os, osVersion, device };
}
