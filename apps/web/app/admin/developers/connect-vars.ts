import { SERVER_NAME } from '@/lib/mcp-connect';
import { CONNECTOR_NAME } from '@/lib/product-name';
import { TOOL_COUNT } from './tool-groups';

/**
 * What the agent pages' copy names (the connect guide, the Tools page, the
 * home promo), filled in on the server with `fillMessages`: the connector's
 * name, the name the server is registered under, and how many tools it has.
 */
export const CONNECT_VARS = { product: CONNECTOR_NAME, server: SERVER_NAME, count: TOOL_COUNT } as const;
