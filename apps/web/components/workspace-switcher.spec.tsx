// @vitest-environment jsdom
/**
 * The person's own workspace switcher: nothing with one workspace, the list
 * with two or more (invitations marked), and a pick goes through the action.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getMessages } from '@slate/shared';
import type { WorkspaceView } from '@slate/types';

const enterWorkspaceAction = vi.fn(async (_id: string): Promise<{ error: 'unavailable' } | void> => undefined);
vi.mock('@/app/admin/workspace-actions', () => ({ enterWorkspaceAction: (id: string) => enterWorkspaceAction(id) }));

import { WorkspaceSwitcher } from './workspace-switcher';

const m = getMessages('en').admin.workspaces;
const ws = (over: Partial<WorkspaceView>): WorkspaceView => ({
  accountId: 'acct',
  accountCode: 'code00',
  accountName: 'Name',
  role: 'member',
  status: 'active',
  current: false,
  home: false,
  ...over,
});
const OWN = ws({ accountId: 'acct_pablo', accountName: 'Pablo', role: 'owner', current: true, home: true });
const INVITED = ws({ accountId: 'acct_alejandro', accountName: 'Alejandro Sales', status: 'invited' });

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  enterWorkspaceAction.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 10, y: 20, width: 240, height: 44 }));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(workspaces: WorkspaceView[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<WorkspaceSwitcher workspaces={workspaces} messages={m} />));
  return container;
}

describe('WorkspaceSwitcher', () => {
  it('renders nothing for a person with one workspace', async () => {
    const el = await render([OWN]);
    expect(el.innerHTML).toBe('');
  });

  it('shows the current workspace and lists the others, invitations marked', async () => {
    const el = await render([OWN, INVITED]);
    const trigger = el.querySelector<HTMLButtonElement>('[data-testid="workspace-switcher-trigger"]')!;
    expect(trigger.textContent).toContain('Pablo');
    await act(async () => trigger.click());

    const menu = document.querySelector('[data-testid="workspace-switcher-menu"]')!;
    const rows = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(rows.map((r) => r.textContent)).toEqual([`Pablo${m.current}`, `Alejandro Sales${m.pending}`]);
    expect(rows[0]!.getAttribute('aria-current')).toBe('true');
    expect(rows[0]!.disabled).toBe(true);
  });

  it('opens a workspace through the action, and says so when it is refused', async () => {
    enterWorkspaceAction.mockResolvedValueOnce({ error: 'unavailable' });
    const el = await render([OWN, INVITED]);
    await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="workspace-switcher-trigger"]')!.click());
    const invited = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((r) =>
      r.textContent?.includes('Alejandro Sales'),
    )!;
    await act(async () => invited.click());
    expect(enterWorkspaceAction).toHaveBeenCalledWith('acct_alejandro');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(m.switchFailed);
  });
});
