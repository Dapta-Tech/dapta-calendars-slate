import { getMessages, type Locale } from '@slate/shared';
import { BrandedShell } from '@/components/branded-shell';
import { ServiceBusy } from '@/components/service-busy';

/**
 * A whole public page the scheduling service was too busy to serve (a 429),
 * rendered in place of the page rather than thrown to the error boundary: a
 * busy service is not an outage, and the visitor is told what is happening and
 * that the page will try again by itself. The host's branding is not known
 * here (reading it is what was refused), so the defaults apply.
 */
export function BusyPage({ locale, retryAfterMs }: { locale: Locale; retryAfterMs: number }) {
  const copy = getMessages(locale).trouble;
  return (
    <BrandedShell brandColor={null} style={null} className="bp-viewport">
      <main className="w-full py-10 md:px-6 md:py-12">
        <div className="bp-flow">
          <div className="bp-stage" data-step="done">
            <ServiceBusy copy={copy} retryAfterMs={retryAfterMs} />
          </div>
        </div>
      </main>
    </BrandedShell>
  );
}
