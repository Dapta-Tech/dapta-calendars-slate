import type { BrandingState } from './branding-setting';

/**
 * What the branding row shows when its status cannot be read (an older API, or
 * the endpoint failing): the default, branding on, switch locked. The rest of
 * Settings > General must not go down with it, the same way the studio treats
 * the vanity link's status.
 */
export const BRANDING_UNREAD: BrandingState = { hideBranding: false, canHide: false, showing: true };
