/** DI tokens. Explicit tokens keep injection working without decorator metadata. */
export const ENV = Symbol('ENV');
export const DB = Symbol('DB');
export const EMAIL = Symbol('EMAIL');
export const NOTIFIER = Symbol('NOTIFIER');
export const CALENDAR = Symbol('CALENDAR');
export const CRM = Symbol('CRM');
export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');
export const RATE_LIMITER = Symbol('RATE_LIMITER');
export const ENTITLEMENTS = Symbol('ENTITLEMENTS');
export const PREMIUM_MODE = Symbol('PREMIUM_MODE');
export const ENTITLEMENT_GATE = Symbol('ENTITLEMENT_GATE');
export const ANALYTICS = Symbol('ANALYTICS');
export const ERROR_REPORTER = Symbol('ERROR_REPORTER');
