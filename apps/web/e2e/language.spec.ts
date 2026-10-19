import { expect, test } from '@playwright/test';
import { HOST } from './stack';

/**
 * A Spanish speaker's first visit, with no language saved yet: the sign-in and
 * the dashboard are in Spanish because the browser is, a link that leads
 * nowhere says so in Spanish, and each document declares it
 * (`<html lang="es">`). Locators avoid copy that is itself being translated,
 * so the test reads the same in either language.
 */
test.use({ locale: 'es-ES' });

test('a dead booking link: a real 404, in the visitor\'s language', async ({ page }) => {
  const res = await page.goto('/acme/nobody');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: 'Página no encontrada' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
});

test('sign-in and dashboard follow the browser language when nothing is saved', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
  await expect(page).toHaveTitle(/^Iniciar sesión · /);

  await page.locator('input[type="email"]').fill(HOST.email);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/admin/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('link', { name: 'Reservas' }).first()).toBeVisible();

  // A saved choice outranks the browser, and the document follows it at once:
  // the switch re-renders the root layout, no reload.
  await page.goto('/admin/settings/general');
  await page.getByRole('button', { name: 'Idioma' }).click();
  await page.getByRole('option', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: 'Bookings' }).first()).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test.describe('in English', () => {
  test.use({ locale: 'en-US' });

  test('a dead event link: a real 404, in English', async ({ page }) => {
    const res = await page.goto(`/${HOST.accountCode}/${HOST.handle}/no-such-event`);
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});
