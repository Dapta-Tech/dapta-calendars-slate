/**
 * The MCP against the dashboard API reference. Walks every documented route
 * and fails when one has no MCP tool and no exclusion saying why, when a map
 * names a route or a tool that does not exist, or when a tool's read, write
 * and destructive marks disagree with the route it serves.
 */
import { describe, expect, it } from 'vitest';
import { API_REFERENCE, apiEndpoints } from '../api-reference';
import { API_ROUTE_EXCLUSIONS, API_ROUTE_TOOLS, parityCoverage, type ExclusionKind } from './parity';
import { TOOLS } from './tools';

const tools = new Map(TOOLS.map((t) => [t.name, t]));
const KINDS: readonly ExclusionKind[] = ['excluded', 'dashboard-only', 'not-yet'];

describe('the MCP against the dashboard API reference', () => {
  it('has a tool for every documented route, or an exclusion that says why', () => {
    const uncovered = apiEndpoints()
      .map((e) => e.route)
      .filter((route) => !API_ROUTE_TOOLS[route] && !API_ROUTE_EXCLUSIONS[route]);
    expect(uncovered).toEqual([]);
  });

  it('never both serves and excludes a route', () => {
    const both = Object.keys(API_ROUTE_TOOLS).filter((route) => API_ROUTE_EXCLUSIONS[route]);
    expect(both).toEqual([]);
  });

  it('names only routes the reference documents, and only tools the server registers', () => {
    const documented = new Set(Object.keys(API_REFERENCE));
    for (const route of [...Object.keys(API_ROUTE_TOOLS), ...Object.keys(API_ROUTE_EXCLUSIONS)]) {
      expect(documented.has(route), route).toBe(true);
    }
    for (const [route, tool] of Object.entries(API_ROUTE_TOOLS)) expect(tools.has(tool), `${route} -> ${tool}`).toBe(true);
  });

  it('gives every exclusion a known kind and a reason', () => {
    for (const [route, e] of Object.entries(API_ROUTE_EXCLUSIONS)) {
      expect(KINDS, route).toContain(e.kind);
      expect(e.reason.trim(), route).not.toBe('');
    }
  });

  it('marks a tool read-only for a GET, a write otherwise, and destructive when its route is', () => {
    for (const e of apiEndpoints()) {
      const tool = tools.get(API_ROUTE_TOOLS[e.route] ?? '');
      if (!tool) continue;
      const label = `${e.route} -> ${tool.name}`;
      if (e.method === 'GET') {
        expect(tool.annotations.readOnlyHint, label).toBe(true);
        expect(tool.write, label).toBe(false);
      } else {
        expect(tool.annotations.readOnlyHint, label).toBe(false);
        expect(tool.write, label).toBe(true);
      }
      if (e.destructive) expect(tool.annotations.destructiveHint, label).toBe(true);
    }
  });

  /**
   * The sentence is fixed so a test can find it: "Owners and admins only." for
   * an admin route, "The account owner only." for an owner route.
   */
  it('tells the agent which tools are for owners and admins, as the reference does', () => {
    for (const e of apiEndpoints()) {
      const tool = tools.get(API_ROUTE_TOOLS[e.route] ?? '');
      if (!tool) continue;
      const label = `${e.route} -> ${tool.name}`;
      expect(tool.description.includes('Owners and admins only.'), label).toBe(e.access === 'admin');
      expect(tool.description.includes('The account owner only.'), label).toBe(e.access === 'owner');
    }
  });

  it('counts every route once', () => {
    const c = parityCoverage();
    expect(c.tool + c.excluded + c['dashboard-only'] + c['not-yet']).toBe(Object.keys(API_REFERENCE).length);
  });
});
