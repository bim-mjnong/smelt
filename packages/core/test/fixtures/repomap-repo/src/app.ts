import { readSettings } from './settings.ts';

export function bootApp(): string {
  const first = readSettings();
  const second = readSettings();
  return first + second + renderBanner();
}

export function renderBanner(): string {
  return 'banner';
}
