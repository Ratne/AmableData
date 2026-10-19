import { render } from 'preact';
import type { SigningView } from '../types';
import { SigningApi } from './api';
import { App } from './App';
import { STYLES } from './styles';

/**
 * Signing page app: the edge renders `#amable-sign` (base path of the link)
 * and the initial view as inline JSON; everything else goes through the
 * same-origin JSON actions.
 */
function boot(): void {
  const root = document.getElementById('amable-sign');
  const data = document.getElementById('amable-sign-view');
  const base = root?.getAttribute('data-base');
  if (root === null || data === null || base === null || base === undefined) return;
  let view: SigningView;
  try {
    view = JSON.parse(data.textContent ?? '') as SigningView;
  } catch {
    return;
  }
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);
  render(<App initial={view} api={new SigningApi(base)} />, root);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
