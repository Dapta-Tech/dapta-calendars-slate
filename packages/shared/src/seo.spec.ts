import { describe, expect, it } from 'vitest';
import { getMessages } from './i18n';
import { eventPageTitle, titleNames } from './seo';

const EN = getMessages('en').growth.seoEventTitle;
const ES = getMessages('es').growth.seoEventTitle;

describe('titleNames', () => {
  it('finds a first name the title already says', () => {
    expect(titleNames('An interview with Felipe', 'Felipe')).toBe(true);
    expect(titleNames('Chat with Felipe', 'Felipe Gomez')).toBe(true);
    expect(titleNames("Felipe's office hours", 'Felipe Gomez')).toBe(true);
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

  it('says no when the title does not name the person', () => {
    expect(titleNames('Intro Call', 'Alex Rivera')).toBe(false);
    expect(titleNames('Intro Call', '')).toBe(false);
  });
});

describe('eventPageTitle', () => {
  it('never says the host twice', () => {
    expect(eventPageTitle(EN, 'An interview with Felipe', 'Felipe')).toBe('An interview with Felipe');
    expect(eventPageTitle(ES, 'Una entrevista con Felipe', 'Felipe')).toBe('Una entrevista con Felipe');
  });

  it('adds the host when the title does not name them', () => {
    expect(eventPageTitle(EN, 'Intro Call', 'Alex Rivera')).toBe('Intro Call with Alex Rivera');
    expect(eventPageTitle(ES, 'Intro Call', 'Alex Rivera')).toBe('Intro Call con Alex Rivera');
  });

  it('treats a team name the same way', () => {
    expect(eventPageTitle(EN, 'Sales demo', 'Sales')).toBe('Sales demo');
    expect(eventPageTitle(EN, 'Discovery call', 'Sales')).toBe('Discovery call with Sales');
  });
});
