import { describe, expect, it } from 'vitest';
import { getMessages } from './i18n';
import { eventPageTitle, titleNames } from './seo';

const EN = getMessages('en').growth.seoEventTitle;
const ES = getMessages('es').growth.seoEventTitle;

describe('titleNames', () => {
  it('finds a first name the title already says', () => {
    expect(titleNames('An interview with Ana', 'Ana')).toBe(true);
    expect(titleNames('Chat with Ana', 'Ana Ruiz')).toBe(true);
    expect(titleNames("Ana's office hours", 'Ana Ruiz')).toBe(true);
  });

  it('ignores case and accents', () => {
    expect(titleNames('Consulta con JOSE', 'José Pérez')).toBe(true);
    expect(titleNames('Consulta con José', 'jose-perez')).toBe(true);
  });

  it('matches whole words only', () => {
    expect(titleNames('Annual review', 'Ann Lee')).toBe(false);
    expect(titleNames('Alexander intro', 'Alex Rivera')).toBe(false);
  });

  it('counts a one-letter first name only inside the whole name', () => {
    expect(titleNames('A quick call', 'A. Ruiz')).toBe(false);
    expect(titleNames('Call with A. Ruiz', 'A. Ruiz')).toBe(true);
  });

  it('never takes an article or a preposition for a first name', () => {
    expect(titleNames('Una cita de prueba', 'De la Cruz')).toBe(false);
    expect(titleNames('Consulta con De la Cruz', 'De la Cruz')).toBe(true);
    expect(titleNames('Meet the founders', 'The Growth Team')).toBe(false);
  });

  it('lets a first name that is also a common word stand alone, the safe way to be wrong', () => {
    expect(titleNames('Mark your calendar', 'Mark Diaz')).toBe(true);
  });

  it('matches a team only on its whole name', () => {
    const team = { firstName: false };
    expect(titleNames('Meet the founders', 'The Growth Team', team)).toBe(false);
    expect(titleNames('Consulta de la mañana', 'La Clínica', team)).toBe(false);
    expect(titleNames('Primera consulta en La Clínica', 'La Clínica', team)).toBe(true);
    expect(titleNames('Sales demo', 'Sales', team)).toBe(true);
  });

  it('says no when the title does not name the person', () => {
    expect(titleNames('Intro Call', 'Alex Rivera')).toBe(false);
    expect(titleNames('Intro Call', '')).toBe(false);
  });
});

describe('eventPageTitle', () => {
  it('never says the host twice', () => {
    expect(eventPageTitle(EN, 'An interview with Ana', 'Ana')).toBe('An interview with Ana');
    expect(eventPageTitle(ES, 'Una entrevista con Ana', 'Ana')).toBe('Una entrevista con Ana');
  });

  it('adds the host when the title does not name them', () => {
    expect(eventPageTitle(EN, 'Intro Call', 'Alex Rivera')).toBe('Intro Call with Alex Rivera');
    expect(eventPageTitle(ES, 'Intro Call', 'Alex Rivera')).toBe('Intro Call con Alex Rivera');
  });

  it('names a team once, by its whole name', () => {
    const team = { firstName: false };
    expect(eventPageTitle(EN, 'Sales demo', 'Sales', team)).toBe('Sales demo');
    expect(eventPageTitle(EN, 'Discovery call', 'Sales', team)).toBe('Discovery call with Sales');
    expect(eventPageTitle(EN, 'Meet the founders', 'The Growth Team', team)).toBe(
      'Meet the founders with The Growth Team',
    );
    expect(eventPageTitle(ES, 'Consulta de la mañana', 'La Clínica', team)).toBe(
      'Consulta de la mañana con La Clínica',
    );
  });
});
