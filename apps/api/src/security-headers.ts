import type { NextFunction, Request, Response } from 'express';

/**
 * Response headers every API answer carries.
 *
 * This is a JSON API, so a Content-Security-Policy buys little; these are the
 * ones that matter for it:
 *
 * - `X-Content-Type-Options: nosniff`: a browser must not reinterpret a JSON
 *   body (which can echo caller input) as HTML or script.
 * - `Referrer-Policy: no-referrer`: the API's own pages (`/docs`) never send
 *   the URL they were opened at to another origin.
 * - `X-Frame-Options: DENY`: nothing here is meant to be framed.
 *
 * `X-Powered-By` is removed separately (`app.disable('x-powered-by')`).
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}
