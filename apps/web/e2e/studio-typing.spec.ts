import { expect, test, type Page } from '@playwright/test';
import { signIn } from './stack';

/**
 * Typing a name into the booking-page studio keeps every key, whatever the
 * preview shows and however the window changes size meanwhile.
 *
 * Production reported React #185 (maximum update depth) once, from the Display
 * name input's change handler, on a host whose window had just gone from 1920
 * to 1534 px wide. A thrown update loses that keystroke. These walk the same
 * path: both previews, the desktop frame (which zooms by a ResizeObserver) and
 * a window resized while typing.
 */
test.skip(({ isMobile }) => isMobile, 'the studio edits on a desktop window');

const NAME = 'Jordan Lee de la Torre Montenegro Villalobos';

async function openStudio(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.setViewportSize({ width: 1534, height: 847 });
  await page.goto('/admin/settings/booking-page');
  await signIn(page, 'jordan@example.com');
  await expect(page.getByRole('textbox', { name: 'Display name' })).toBeVisible();
  return errors;
}

for (const surface of ['Profile', 'Booking flow'] as const) {
  test(`${surface} preview: every key typed into the display name lands`, async ({ page }) => {
    const errors = await openStudio(page);
    await page.getByRole('button', { name: surface, exact: true }).click();
    await page.getByRole('button', { name: 'desktop', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Display name' });
    await input.fill('');
    await input.pressSequentially(NAME);
    await expect(input).toHaveValue(NAME);
    expect(errors.filter((e) => /#185|Maximum update depth/i.test(e))).toEqual([]);
  });

  test(`${surface} preview: typing while the window changes size keeps every key`, async ({ page }) => {
    const errors = await openStudio(page);
    await page.getByRole('button', { name: surface, exact: true }).click();
    await page.getByRole('button', { name: 'desktop', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Display name' });
    await input.fill('');
    const sizes = [
      { width: 1920, height: 911 },
      { width: 1534, height: 847 },
      { width: 1280, height: 800 },
      { width: 1535, height: 847 },
    ];
    let typed = '';
    for (const [i, ch] of [...NAME].entries()) {
      if (i % 6 === 0) await page.setViewportSize(sizes[(i / 6) % sizes.length]!);
      await input.press(ch === ' ' ? 'Space' : ch);
      typed += ch;
    }
    await expect(input).toHaveValue(typed);
    expect(errors.filter((e) => /#185|Maximum update depth/i.test(e))).toEqual([]);
  });
}
