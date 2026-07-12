import type { EmailProvider } from './email.port';
import { LogOnlyEmailProvider } from './adapters/log-only';
import { NoopEmailProvider } from './adapters/noop';
import { SmtpEmailProvider } from './adapters/smtp';
import { HttpEmailProvider, type HttpWireProfile } from './adapters/http';

export interface EmailConfig {
  provider: 'log-only' | 'noop' | 'smtp' | 'http';
  fromEmail: string;
  fromName?: string;
  smtp?: {
    host?: string;
    port?: number;
    secure?: boolean;
    user?: string;
    pass?: string;
  };
  http?: {
    endpoint?: string;
    /** Wire/profile to speak (`generic` default, or `transactional-v1`). */
    profile?: HttpWireProfile;
    /** Bearer token — `generic` profile. */
    token?: string;
    /** X-API-Key — `transactional-v1` profile. */
    apiKey?: string;
    /** Message category — `transactional-v1` profile (defaults to `lifecycle`). */
    category?: string;
  };
}

/**
 * Select the EmailProvider from configuration. Falls back to log-only whenever a
 * chosen provider is missing its required settings, so the app always boots and
 * booking flows always complete (rule 1: a bare fork runs with nothing set).
 */
export function createEmailProvider(config: EmailConfig): EmailProvider {
  switch (config.provider) {
    case 'noop':
      return new NoopEmailProvider();
    case 'smtp':
      if (config.smtp?.host) {
        return new SmtpEmailProvider({
          host: config.smtp.host,
          port: config.smtp.port ?? 587,
          secure: config.smtp.secure ?? false,
          user: config.smtp.user,
          pass: config.smtp.pass,
          fromEmail: config.fromEmail,
          fromName: config.fromName,
        });
      }
      return new LogOnlyEmailProvider();
    case 'http':
      if (config.http?.endpoint) {
        if (
          config.http.profile === 'transactional-v1' &&
          (!config.http.clientId || !config.http.signingSecret)
        ) {
          throw new Error('transactional-v1 requires a client id and signing secret');
        }
        return new HttpEmailProvider({
          endpoint: config.http.endpoint,
          profile: config.http.profile,
          token: config.http.token,
          apiKey: config.http.apiKey,
          category: config.http.category,
          fromEmail: config.fromEmail,
          fromName: config.fromName,
        });
      }
      return new LogOnlyEmailProvider();
    case 'log-only':
    default:
      return new LogOnlyEmailProvider();
  }
}
