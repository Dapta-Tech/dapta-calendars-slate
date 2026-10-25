/**
 * The Tools page groups the server's tools by hand: the web app shares no
 * module with the API. Held to the server's catalog here, read as text the way
 * the API's directory review reads the web's tool list: every tool the server
 * registers in `TOOLS` sits in exactly one group, none that it does not, and
 * both languages have the plain-language copy for exactly those tools.
 */
import { describe, expect, it } from 'vitest';
import { getMessages } from '@slate/shared';
import { servedTools } from '@/lib/test/mcp-catalog';
import { TOOL_COUNT, TOOL_GROUPS, TOOL_GROUP_ICONS, TOOL_GROUP_ORDER } from './tool-groups';

describe('TOOL_GROUPS', () => {
  const grouped = Object.values(TOOL_GROUPS).flat() as string[];
  const served = servedTools();

  it('reads the server catalog (a parse that finds nothing would pass everything)', () => {
    expect(served.length).toBeGreaterThanOrEqual(17);
    expect(new Set(served).size).toBe(served.length);
  });

  it('places every tool the MCP serves in exactly one group, and invents none', () => {
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...served].sort());
    expect(TOOL_COUNT).toBe(served.length);
  });

  it('shows every group once, each with an icon', () => {
    expect([...TOOL_GROUP_ORDER].sort()).toEqual(Object.keys(TOOL_GROUPS).sort());
    for (const g of TOOL_GROUP_ORDER) expect(TOOL_GROUP_ICONS[g]).toMatch(/^pi-[a-z-]+$/);
  });

  it('has plain-language copy for every tool and group in both languages, and none for tools that do not exist', () => {
    for (const l of ['en', 'es'] as const) {
      const tools = getMessages(l).admin.tools;
      expect(Object.keys(tools.items).sort(), l).toEqual([...served].sort());
      for (const name of served) {
        expect(tools.items[name]!.what, `${l} ${name}`).toBeTruthy();
        expect(tools.items[name]!.ask, `${l} ${name}`).toBeTruthy();
      }
      expect(Object.keys(tools.groups).sort(), l).toEqual(Object.keys(TOOL_GROUPS).sort());
    }
  });
});
