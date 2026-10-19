import type { BookingMessages } from '@slate/shared';
import { buttonVariants } from '@/components/ui/button';

type DevMessages = BookingMessages['admin']['developer'];

/** Links to the API's own reference. The origin is resolved on the server at runtime. */
export function ApiReference({ apiOrigin, messages: m }: { apiOrigin: string | null; messages: DevMessages }) {
  return (
    <section className="mt-section">
      <h2 className="mb-tight text-xl font-semibold">{m.apiRefTitle}</h2>
      <p className="mb-field max-w-prose text-sm text-muted-foreground">{m.apiRefLead}</p>
      {apiOrigin ? (
        <div className="flex flex-wrap gap-inline">
          <a href={`${apiOrigin}/docs`} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            {m.apiDocs}
          </a>
          <a href={`${apiOrigin}/openapi.json`} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            <code className="font-mono">{m.apiOpenApi}</code>
          </a>
        </div>
      ) : (
        <p className="max-w-prose text-sm text-muted-foreground">{m.apiRefMissing}</p>
      )}
    </section>
  );
}
