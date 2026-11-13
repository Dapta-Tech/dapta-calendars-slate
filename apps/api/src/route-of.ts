/**
 * Read the routes a controller serves from its own Nest metadata, as
 * `METHOD /path/:param` exactly as the decorators declare them. The API
 * reference, its spec and the MCP parity spec all name routes this way, so
 * they see the routes the app really serves, never a hand-copied list.
 */
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';

/** Nest's route metadata keys (`@nestjs/common/constants`), named here to avoid a deep CJS import. */
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

/** Join a controller prefix and a handler path into `/a/b/:c`. */
export function joinRoutePath(...parts: (string | string[] | undefined)[]): string {
  const segments = parts
    .map((p) => (Array.isArray(p) ? p[0] : p) ?? '')
    .join('/')
    .split('/')
    .filter(Boolean);
  return `/${segments.join('/')}`;
}

/** The `METHOD /path` of a controller handler, from its route metadata; null when it has none. */
export function routeOf(controller: object, handler: object): string | null {
  const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
  const path = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
  if (method === undefined || path === undefined) return null;
  const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined;
  return `${RequestMethod[method]} ${joinRoutePath(prefix, path)}`;
}

/** One served route and the handler behind it. */
export interface ServedRoute {
  route: string;
  handlerName: string;
  handler: (...args: never[]) => unknown;
}

/** Every route a controller class serves, in declaration order. */
export function routesOf(controller: abstract new (...args: never[]) => unknown): ServedRoute[] {
  const out: ServedRoute[] = [];
  for (const name of Object.getOwnPropertyNames(controller.prototype)) {
    if (name === 'constructor') continue;
    const handler = Object.getOwnPropertyDescriptor(controller.prototype, name)?.value as unknown;
    if (typeof handler !== 'function') continue;
    const route = routeOf(controller, handler);
    if (route) out.push({ route, handlerName: name, handler: handler as ServedRoute['handler'] });
  }
  return out;
}
