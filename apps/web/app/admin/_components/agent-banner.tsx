import Link from 'next/link';
import type { BookingMessages } from '@slate/shared';
import { AgentLogo } from '@/components/agent-logos';
import { MCP_APPS, MCP_APP_NAMES } from '@/components/mcp-apps';
import { buttonVariants } from '@/components/ui/button';
import { DEVELOPERS_CONNECT_HREF } from '@/lib/admin-nav';
import './agent-promo.css';

type BannerMessages = BookingMessages['admin']['home']['agentBanner'];

/**
 * The home's top banner: run the calendar from an AI agent, a marquee of the
 * apps' official logos, and the way to connect. It stays on the home, as the
 * dForms banner does.
 */
export function AgentBanner({ m }: { m: BannerMessages }) {
  return (
    <section
      aria-labelledby="agent-banner-title"
      data-testid="home-agent-banner"
      className="ap-banner relative mb-section overflow-hidden rounded-2xl border border-signal/40 bg-gradient-to-r from-signal/[0.12] via-signal/[0.05] to-card"
    >
      <div className="flex flex-col gap-card p-card sm:p-group lg:flex-row lg:items-center lg:gap-section">
        <div className="min-w-0 lg:max-w-md">
          <h2 id="agent-banner-title" className="text-lg font-semibold leading-snug text-foreground sm:text-xl">
            {m.title}
          </h2>
          <p className="mt-tight text-sm text-muted-foreground">{m.body}</p>
        </div>
        <div className="ap-marquee min-w-0 flex-1 overflow-hidden" data-testid="home-agent-marquee">
          <div className="ap-marquee__track">
            {[0, 1].map((copy) => (
              <ul
                key={copy}
                aria-hidden={copy === 1 || undefined}
                className={`flex shrink-0 items-center gap-field pr-field${copy === 1 ? ' ap-marquee__copy' : ''}`}
              >
                {MCP_APPS.map((app) => (
                  <li
                    key={app}
                    className="flex h-9 shrink-0 items-center gap-inline rounded-full border border-border bg-card px-field text-sm font-medium text-foreground shadow-sm"
                  >
                    <AgentLogo app={app} size={18} />
                    {MCP_APP_NAMES[app]}
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </div>
        <Link
          href={DEVELOPERS_CONNECT_HREF}
          data-testid="home-agent-banner-cta"
          className={`${buttonVariants({ variant: 'default' })} shrink-0 self-start lg:self-center`}
        >
          {m.cta}
          <i aria-hidden className="pi pi-arrow-right" style={{ fontSize: 12 }} />
        </Link>
      </div>
    </section>
  );
}
