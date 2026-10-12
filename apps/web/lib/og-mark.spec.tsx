import { readFileSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CalendarsMark } from '@/components/brand/calendars-logo';

/**
 * The link preview draws the dC mark from `assets/brand/dc-mark.svg`, because a
 * route cannot render the React mark to a string (Next refuses `react-dom/server`
 * there). This holds the file to the component, so the mark on a card cannot
 * drift from the mark in the product. `WRITE_MARK=1` regenerates it.
 */
const FILE = new URL('../assets/brand/dc-mark.svg', import.meta.url);

function rendered(): string {
  const svg = renderToStaticMarkup(<CalendarsMark xmlns="http://www.w3.org/2000/svg" />);
  // `useId` makes the mask id per render; the file pins one name.
  const id = svg.match(/<mask id="([^"]+)"/)![1]!;
  return `${svg.split(`id="${id}"`).join('id="dc-brush"').split(`url(#${id})`).join('url(#dc-brush)')}\n`;
}

describe('the share card mark', () => {
  it('is the product mark, byte for byte', () => {
    if (process.env.WRITE_MARK === '1') writeFileSync(FILE, rendered());
    expect(readFileSync(FILE, 'utf8')).toBe(rendered());
  });
});
