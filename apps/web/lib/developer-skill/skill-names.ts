/**
 * The folder the zip unpacks to, and the skill's `name`. It is the name the
 * MCP server was registered under before `dcal` (decision D3), and it stays:
 * re-running the install updates the skill in place only while the folder
 * keeps its name, so a new one would leave a second copy of the skill beside
 * the first.
 */
export const SKILL_DIR = 'dapta-calendars';

/** The archive's file name; `INSTALL.md` refers to it by this name. */
export const SKILL_ZIP_NAME = `${SKILL_DIR}-skill.zip`;

/** The route that builds the zip, linked from the API keys page. */
export const SKILL_ROUTE = '/api/developers/skill';
