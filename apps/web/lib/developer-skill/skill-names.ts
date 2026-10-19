import { SERVER_NAME } from '../mcp-connect';

/**
 * The folder the zip unpacks to, and the skill's `name`. The same name the MCP
 * server is registered under in an agent's config, so an agent that has both
 * sees one product, not two.
 */
export const SKILL_DIR = SERVER_NAME;

/** The archive's file name; `INSTALL.md` refers to it by this name. */
export const SKILL_ZIP_NAME = `${SKILL_DIR}-skill.zip`;

/** The route that builds the zip, linked from the setup guide. */
export const SKILL_ROUTE = '/api/developers/skill';
