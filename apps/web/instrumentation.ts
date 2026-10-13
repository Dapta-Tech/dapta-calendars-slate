/**
 * Runs once when the web server starts. Configuration the server can only
 * half use is reported here, once, rather than on every request.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { internalApiSecretWarning } = await import('./lib/internal-secret');
  const warning = internalApiSecretWarning();
  if (warning) console.warn(warning);
}
