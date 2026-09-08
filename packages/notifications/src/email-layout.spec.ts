import { describe, it, expect } from 'vitest';
import { renderBrandedHtml, type EmailKind } from './email-layout';
import type { TemplateVariable } from './templates';

const vars = (over: Partial<Record<TemplateVariable, string>> = {}): Record<TemplateVariable, string> => ({
  attendee_name: 'Ana',
  attendee_email: 'ana@example.com',
  host_name: 'Felipe Gómez',
  event_title: 'Intro call',
  start_time: 'Fri, Jul 17 · 9:30 AM',
  end_time: 'Fri, Jul 17 · 10:00 AM',
  location: 'Online meeting',
  manage_url: 'https://calendar.dapta.ai/manage/x?token=t',
  cancel_link: 'https://calendar.dapta.ai/manage/x?token=t',
  reschedule_link: 'https://calendar.dapta.ai/manage/x?token=t',
  cancellation_reason: '',
  previous_start_time: '',
  reminder_lead: '',
  pending_note: '',
  booking_link: 'https://calendar.dapta.ai/acct/felipe/intro',
  ...over,
});

describe('renderBrandedHtml', () => {
  it('renders brand shell + event details for every kind', () => {
    const kinds: EmailKind[] = ['confirmation', 'pending', 'reschedule', 'cancellation', 'declined', 'reminder', 'follow_up'];
    for (const k of kinds) {
      const html = renderBrandedHtml(k, vars(), 'en');
      expect(html).toContain('Dapta Calendars');
      expect(html).toContain('Online meeting'); // location detail row
      expect(html).toContain('Fri, Jul 17'); // when
    }
  });

  it('confirmation shows Reschedule + Cancel CTAs linking to the manage url', () => {
    const html = renderBrandedHtml('confirmation', vars(), 'en');
    expect(html).toContain('Reschedule');
    expect(html).toContain('Cancel');
    expect(html).toContain('https://calendar.dapta.ai/manage/x?token=t');
  });

  it('cancellation shows a book-again CTA and localizes to ES', () => {
    const html = renderBrandedHtml('cancellation', vars(), 'es');
    expect(html).toContain('Reservar otra hora');
    expect(html).toContain('https://calendar.dapta.ai/acct/felipe/intro');
  });

  it('host audience labels the counterparty as the guest', () => {
    const html = renderBrandedHtml('confirmation', vars(), 'en', 'host');
    expect(html).toContain('Ana'); // attendee shown to the host
  });

  it('HTML-escapes interpolated values (no injection via title/name)', () => {
    const html = renderBrandedHtml('confirmation', vars({ host_name: '<script>x</script>' }), 'en');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('drops a CTA whose url is missing (no empty/# button spam)', () => {
    const html = renderBrandedHtml('confirmation', vars({ manage_url: '' }), 'en');
    expect(html).not.toContain('Reschedule');
  });
});
