import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The tool names the API's MCP server registers, in its order, for specs that
 * hold the web app's copies to them. The apps share no module, so the server's
 * catalog (`apps/api/src/mcp/tools.ts`) is read as text: `TOOLS` resolved
 * through each `const x: ToolDef = { name: '...' }`. Throws on a name it cannot
 * resolve, so a change of shape fails loudly instead of passing on nothing.
 */
export function servedTools(): string[] {
  // A path, not `new URL(rel, import.meta.url)`: under a DOM environment Vite
  // rewrites that pattern into an http asset address.
  const file = resolve(dirname(fileURLToPath(import.meta.url)), '../../../api/src/mcp/tools.ts');
  const source = readFileSync(file, 'utf8');
  const defs = new Map([...source.matchAll(/^const (\w+): ToolDef = \{\n {2}name: '([a-z_]+)'/gm)].map((m) => [m[1]!, m[2]!]));
  const list = source.match(/^export const TOOLS: readonly ToolDef\[\] = \[([\s\S]*?)\];/m)?.[1] ?? '';
  return list
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => {
      const name = defs.get(id);
      if (!name) throw new Error(`TOOLS lists ${id}, which cannot be resolved to a tool name`);
      return name;
    });
}
