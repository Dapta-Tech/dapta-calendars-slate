/** Minimal i18n for the booking surface — EN/ES message catalogs + interpolation. */

export type Locale = 'en' | 'es';

export interface BookingMessages {
  booking: {
    selectTime: string;
    durationMinutes: string;
    timezoneLabel: string;
    noSlots: string;
    book: string;
    confirm: string;
    confirming: string;
    confirmed: string;
    yourName: string;
    yourEmail: string;
    notes: string;
    slotTaken: string;
    retry: string;
    poweredBy: string;
  };
}

export const en: BookingMessages = {
  booking: {
    selectTime: 'Select a time',
    durationMinutes: '{minutes} min',
    timezoneLabel: 'Times shown in {timeZone}',
    noSlots: 'No available times in this range.',
    book: 'Book',
    confirm: 'Confirm booking',
    confirming: 'Confirming…',
    confirmed: 'Booking confirmed',
    yourName: 'Your name',
    yourEmail: 'Your email',
    notes: 'Notes (optional)',
    slotTaken: 'That time was just booked. Please pick another slot.',
    retry: 'Try again',
    poweredBy: 'Powered by Slate',
  },
};

export const es: BookingMessages = {
  booking: {
    selectTime: 'Selecciona un horario',
    durationMinutes: '{minutes} min',
    timezoneLabel: 'Horarios en {timeZone}',
    noSlots: 'No hay horarios disponibles en este rango.',
    book: 'Reservar',
    confirm: 'Confirmar reserva',
    confirming: 'Confirmando…',
    confirmed: 'Reserva confirmada',
    yourName: 'Tu nombre',
    yourEmail: 'Tu correo',
    notes: 'Notas (opcional)',
    slotTaken: 'Ese horario acaba de reservarse. Elige otro.',
    retry: 'Reintentar',
    poweredBy: 'Con la tecnología de Slate',
  },
};

export const messages = { en, es } as const;

/** Pick messages for a locale, defaulting to English. */
export function getMessages(locale: string): BookingMessages {
  return locale.startsWith('es') ? es : en;
}

/** Interpolate `{name}` placeholders in a message string. */
export function t(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}
