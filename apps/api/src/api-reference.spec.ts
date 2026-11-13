/**
 * The dashboard API reference against the routes the app really serves.
 *
 * Read off the controllers `AppModule` registers, so a route added to the
 * dashboard fails here until it is described (area, who may call it, whether
 * it destroys something), and a route removed fails until its entry goes.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module';
import { AdminCrudController } from './admin-crud.controller';
import { HostController } from './host.controller';
import { API_AREAS, API_REFERENCE, apiEndpoints, type ApiAccess } from './api-reference';
import { routesOf, type ServedRoute } from './route-of';

const DASHBOARD = [HostController, AdminCrudController];

function dashboardRoutes(): ServedRoute[] {
  return DASHBOARD.flatMap((c) => routesOf(c));
}

/**
 * The permission checks a handler's code makes, from its source. Coarse on
 * purpose: it catches a route that gained or lost a check without its entry
 * here changing, which is the drift that matters.
 */
function checksIn(handler: ServedRoute['handler']): Set<string> {
  const source = handler.toString();
  const found = new Set<string>();
  for (const check of ['assertOwner', 'assertAdmin', 'assertOwnsOrAdmin', 'assertTrackingChange']) {
    if (new RegExp(`\\b${check}\\(`).test(source)) found.add(check);
  }
  return found;
}

/** What each access level requires of the handler's code. */
function agrees(access: ApiAccess, checks: Set<string>): boolean {
  switch (access) {
    case 'owner':
      return checks.has('assertOwner');
    case 'admin':
      return checks.has('assertAdmin') && !checks.has('assertOwnsOrAdmin');
    case 'own':
      return checks.has('assertOwnsOrAdmin') || checks.has('assertAdmin');
    case 'member':
      return !checks.has('assertOwner') && !checks.has('assertAdmin') && !checks.has('assertOwnsOrAdmin');
  }
}

describe('the dashboard API reference', () => {
  const served = dashboardRoutes();

  it('reads the real routes, from the controllers the app registers', () => {
    const registered = Reflect.getMetadata('controllers', AppModule) as unknown[];
    for (const c of DASHBOARD) expect(registered).toContain(c);
    expect(served.map((r) => r.route)).toContain('GET /v1/host/bookings');
    expect(served.map((r) => r.route)).toContain('PATCH /v1/event-types/:id');
  });

  it('describes exactly the routes the dashboard serves, no more and no less', () => {
    const routes = served.map((r) => r.route).sort();
    expect(new Set(routes).size).toBe(routes.length);
    expect(Object.keys(API_REFERENCE).sort()).toEqual(routes);
  });

  it("says who may call each route, as the handler's own checks do", () => {
    const wrong = served
      .map((r) => ({ route: r.route, access: API_REFERENCE[r.route]?.access, checks: [...checksIn(r.handler)] }))
      .filter((r) => r.access === undefined || !agrees(r.access, new Set(r.checks)));
    expect(wrong).toEqual([]);
  });

  it('marks every DELETE destructive', () => {
    for (const e of apiEndpoints()) if (e.method === 'DELETE') expect(e.destructive, e.route).toBe(true);
  });

  it('files every route under a known area, with a one-line summary', () => {
    const entries = apiEndpoints();
    expect(entries).toHaveLength(Object.keys(API_REFERENCE).length);
    for (const e of entries) {
      expect(API_AREAS, e.route).toContain(e.area);
      expect(e.summary.trim(), e.route).not.toBe('');
      expect(e.summary, e.route).not.toContain('\n');
    }
  });
});
