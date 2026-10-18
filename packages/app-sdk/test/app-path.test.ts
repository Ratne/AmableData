import { describe, expect, it } from 'vitest';
import { appPath } from '../src/handler';

const path = (url: string, base: string) => appPath(new URL(url), base);

describe('appPath', () => {
  it('routes apps hosted at the root', () => {
    expect(path('https://my-app.example.dev/hooks/validate', 'https://my-app.example.dev')).toBe('/hooks/validate');
    expect(path('https://my-app.example.dev/', 'https://my-app.example.dev/')).toBe('/');
  });

  it('strips the path of base_url', () => {
    expect(path('https://apps.example.com/kapso/hooks/validate', 'https://apps.example.com/kapso')).toBe('/hooks/validate');
    expect(path('https://apps.example.com/kapso', 'https://apps.example.com/kapso')).toBe('/');
    expect(path('https://apps.example.com/kapso/', 'https://apps.example.com/kapso/')).toBe('/');
  });

  it('refuses requests outside base_url', () => {
    expect(path('https://apps.example.com/kapsoX/hooks', 'https://apps.example.com/kapso')).toBeNull();
    expect(path('https://apps.example.com/emailable/hooks', 'https://apps.example.com/kapso')).toBeNull();
  });
});
