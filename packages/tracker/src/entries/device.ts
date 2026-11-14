import { collectDevice, DEVICE_SESSION_KEY } from '../device';

const amable = (window as unknown as { amable?: unknown }).amable;
let sent: string | null = null;
try {
  sent = window.sessionStorage.getItem(DEVICE_SESSION_KEY);
} catch {
  // storage disabled: sent on every page load
}
if (typeof amable === 'function' && sent === null) {
  void collectDevice(window).then((signals) => {
    (amable as (name: string, data: unknown) => void)('device', signals);
    try {
      window.sessionStorage.setItem(DEVICE_SESSION_KEY, '1');
    } catch {
      // storage disabled
    }
  });
}
