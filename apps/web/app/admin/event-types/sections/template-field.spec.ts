// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseTemplateSegments, serializeTemplateDom } from './template-field';

describe('template field: template ⇄ chips', () => {
  it('splits a template into text and variables, tolerating spaces in the braces', () => {
    expect(parseTemplateSegments('Intro – {{ attendee_name }} ({{form.company}})')).toEqual([
      { text: 'Intro – ' },
      { token: 'attendee_name' },
      { text: ' (' },
      { token: 'form.company' },
      { text: ')' },
    ]);
    expect(parseTemplateSegments('')).toEqual([]);
  });

  it('serializes chips back to {{name}} and line breaks to \\n', () => {
    const root = document.createElement('div');
    const chip = document.createElement('span');
    chip.dataset.token = 'duration';
    chip.textContent = 'Duration';
    root.append('A ', chip, document.createElement('br'), 'call');
    expect(serializeTemplateDom(root)).toBe('A {{duration}}\ncall');
  });
});
