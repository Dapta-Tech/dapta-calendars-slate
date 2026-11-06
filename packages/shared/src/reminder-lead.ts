/**
 * "in 24 hour(s)" / "en 30 minutos": how a reminder email words its lead
 * (`{{reminder_lead}}`). One function for the emails the API sends and the
 * preview the event editor draws, so the preview never words it differently.
 */
export function formatLead(leadMinutes: number | undefined, locale: 'en' | 'es'): string {
  if (leadMinutes == null) return locale === 'es' ? 'pronto' : 'soon';
  const day = 1440;
  if (leadMinutes % day === 0) {
    const d = leadMinutes / day;
    return locale === 'es' ? `en ${d} día(s)` : `in ${d} day(s)`;
  }
  if (leadMinutes % 60 === 0) {
    const h = leadMinutes / 60;
    return locale === 'es' ? `en ${h} hora(s)` : `in ${h} hour(s)`;
  }
  return locale === 'es' ? `en ${leadMinutes} minutos` : `in ${leadMinutes} minutes`;
}
