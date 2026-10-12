import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from './button';
import { StatementHeader } from './page-header';
import { SettingsPanel, SettingsRow } from './settings';
import { StatusChip } from './status-chip';

/**
 * The Phase 1 primitives, pinned on the parts a reader of a screen relies on:
 * the one colour each state is allowed, the label always present beside it, and
 * the shapes built from the spacing ROLES rather than from numbers.
 */
describe('StatusChip', () => {
  it.each([
    ['confirmed', 'bg-signal/20', 'bg-signal-edge'],
    ['pending', 'bg-warning/20', 'bg-warning'],
    ['cancelled', 'bg-muted', 'bg-faint'],
  ] as const)('%s wears its own wash and dot, and always says its label', (status, wash, dot) => {
    const html = renderToStaticMarkup(<StatusChip status={status} label="Label" testId="chip" />);
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain(wash);
    expect(html).toContain(dot);
    expect(html).toContain('>Label<');
    // The dot is decoration; the word is the signal.
    expect(html).toContain('aria-hidden="true"');
  });

  it('never paints a state in the primary', () => {
    for (const status of ['confirmed', 'pending', 'cancelled'] as const) {
      expect(renderToStaticMarkup(<StatusChip status={status} label="x" />)).not.toMatch(/bg-primary/);
    }
  });
});

describe('StatementHeader', () => {
  it('sets the title and the statement at the same size, the statement faint', () => {
    const html = renderToStaticMarkup(<StatementHeader title="Settings" statement="Your page, your hours." />);
    expect(html).toMatch(/<h1 class="text-3xl[^"]*">Settings<\/h1>/);
    expect(html).toMatch(/<p class="text-3xl[^"]*text-faint">Your page, your hours.<\/p>/);
  });
});

describe('SettingsRow and SettingsPanel', () => {
  it('rules every row but the first', () => {
    expect(renderToStaticMarkup(<SettingsRow title="A" first>x</SettingsRow>)).not.toContain('border-t');
    expect(renderToStaticMarkup(<SettingsRow title="B">x</SettingsRow>)).toContain('border-t border-border');
  });

  it('boxes only the panel, on the work ground when it is a well', () => {
    expect(renderToStaticMarkup(<SettingsPanel tone="well">x</SettingsPanel>)).toContain('bg-panel');
    expect(renderToStaticMarkup(<SettingsPanel>x</SettingsPanel>)).toContain('border border-border bg-card');
  });

  it('spaces by role, never by number', () => {
    const html = renderToStaticMarkup(
      <>
        <SettingsRow title="A" hint="h">
          x
        </SettingsRow>
        <SettingsPanel title="T" hint="h">
          x
        </SettingsPanel>
      </>,
    );
    expect(html).not.toMatch(/\b(?:p|px|py|m|mt|mb|gap)-\d/);
  });
});

describe('Button', () => {
  it('draws the primary in ink and the destructive as an outline', () => {
    expect(renderToStaticMarkup(<Button>Save</Button>)).toContain('bg-primary text-primary-foreground');
    const destructive = renderToStaticMarkup(<Button variant="destructive">Delete</Button>);
    expect(destructive).toContain('border border-destructive text-destructive');
    expect(destructive).not.toContain('bg-destructive ');
  });

  it('has a soft variant for the action beside the primary', () => {
    expect(renderToStaticMarkup(<Button variant="soft">Cancel</Button>)).toContain('bg-muted text-foreground');
  });
});
