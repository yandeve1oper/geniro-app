// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../../shared/contracts';
import {
  aKnowledgeDocument,
  aKnowledgeHead,
  aKnowledgeRevision,
} from '../__fixtures__/knowledge';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import { aProject } from '../__fixtures__/projects';
import type { DaemonClient } from '../daemon-client';

const knowledgeApi = vi.hoisted(() => ({
  listKnowledge: vi.fn(),
  knowledgeCounts: vi.fn(),
  readKnowledge: vi.fn(),
  createKnowledge: vi.fn(),
  updateKnowledge: vi.fn(),
  listKnowledgeRevisions: vi.fn(),
  readKnowledgeRevision: vi.fn(),
  approveKnowledgeRevision: vi.fn(),
  rejectKnowledgeRevision: vi.fn(),
  restoreKnowledgeRevision: vi.fn(),
  archiveKnowledge: vi.fn(),
  restoreKnowledge: vi.fn(),
  indexKnowledge: vi.fn(),
  searchOnlyKnowledge: vi.fn(),
  deleteKnowledge: vi.fn(),
  exportKnowledge: vi.fn(),
}));
const projectsApi = vi.hoisted(() => ({ listProjects: vi.fn() }));
const teamsApi = vi.hoisted(() => ({ listTeams: vi.fn() }));

vi.mock('../daemon-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../daemon-api')>()),
  createDaemonApis: () => ({
    knowledge: knowledgeApi,
    projects: projectsApi,
    teams: teamsApi,
  }),
}));

const { Knowledge } = await import('./Knowledge');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const handle: DaemonHandle = {
  host: '127.0.0.1',
  port: 1,
  token: 't',
  version: '1',
  startedAt: '2026-01-01T00:00:00.000Z',
};

const STALE = new Error(
  'daemon PATCH /v1/knowledge/d1 failed (409): {"code":"KNOWLEDGE_STALE","message":"the document changed"}',
);
const PROPOSAL_STALE = new Error(
  'daemon POST /v1/knowledge/revisions/r1/approve failed (409): {"code":"PROPOSAL_STALE","message":"moved on"}',
);

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let changed: ((event: unknown) => void)[] = [];

const client = {
  onKnowledgeChanged: (listener: (event: unknown) => void) => {
    changed.push(listener);
    return () => undefined;
  },
  onReconnect: () => () => undefined,
  onProjectsChanged: () => () => undefined,
} as unknown as DaemonClient;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(
  props: Partial<React.ComponentProps<typeof Knowledge>> = {},
): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <Knowledge
        handle={handle}
        client={client}
        place={null}
        onPlaceChange={() => undefined}
        request={null}
        onRequestHandled={() => undefined}
        onDocumentShown={() => undefined}
        remote={false}
        {...props}
      />,
    );
  });
  await settle();
  return container;
}

function button(el: HTMLElement, name: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find(
    (candidate) =>
      candidate.textContent?.trim() === name ||
      candidate.getAttribute('aria-label') === name,
  );
  if (!found) {
    throw new Error(`no button ${name}`);
  }
  return found;
}

async function press(el: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    button(el, name).click();
  });
  await settle();
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const page = (documents = [aKnowledgeHead()], next: string | null = null) => ({
  documents,
  next,
});

beforeEach(() => {
  changed = [];
  window.geniro = createPreloadStub();
  Object.values(knowledgeApi).forEach((mock) => mock.mockReset());
  knowledgeApi.listKnowledge.mockResolvedValue(page());
  knowledgeApi.knowledgeCounts.mockResolvedValue({
    places: [],
    active: 1,
    waiting: 0,
  });
  knowledgeApi.readKnowledge.mockResolvedValue(aKnowledgeDocument());
  projectsApi.listProjects.mockResolvedValue([
    aProject({ id: 'p1', name: 'Atlas' }),
  ]);
  teamsApi.listTeams.mockResolvedValue([
    { slug: 'delivery', name: 'Delivery' },
  ]);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('Knowledge — the list', () => {
  it('lists documents with their place and never reads a body', async () => {
    const el = await mount();

    expect(el.textContent).toContain('Release checklist');
    expect(el.textContent).toContain('Atlas');
    expect(el.textContent).toContain('Cutting a release');
    expect(knowledgeApi.readKnowledge).not.toHaveBeenCalled();
  });

  it('filters by the place the shell holds', async () => {
    await mount({ place: 'project:p1' });

    expect(knowledgeApi.listKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ place: 'project:p1', status: 'active' }),
    );
  });

  it('searches as the user types', async () => {
    const el = await mount();
    await type(
      el.querySelector<HTMLInputElement>('[aria-label="Search documents"]')!,
      'release',
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));

    expect(knowledgeApi.listKnowledge).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'release' }),
    );
  });

  it('shows how many wait, and that chip opens the waiting filter', async () => {
    knowledgeApi.knowledgeCounts.mockResolvedValue({
      places: [],
      active: 1,
      waiting: 2,
    });
    const el = await mount();

    await press(el, '2 waiting');

    expect(knowledgeApi.listKnowledge).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'waiting' }),
    );
    expect(el.textContent).not.toContain('2 waiting');
  });

  it('offers a new document on an empty place, and says when filters found nothing', async () => {
    knowledgeApi.listKnowledge.mockResolvedValue(page([]));
    const el = await mount();

    expect(el.textContent).toContain('No documents here yet');

    await type(
      el.querySelector<HTMLInputElement>('[aria-label="Search documents"]')!,
      'nothing',
    );
    await settle();
    expect(el.textContent).toContain('Nothing matches');
  });

  it('says a failed read and retries it', async () => {
    knowledgeApi.listKnowledge.mockRejectedValueOnce(
      new Error('daemon GET /v1/knowledge failed (500): boom'),
    );
    const el = await mount();

    expect(el.textContent).toContain('failed (500)');

    await press(el, 'Retry');
    expect(el.textContent).toContain('Release checklist');
  });

  it('reads again when a knowledge write lands', async () => {
    await mount();
    knowledgeApi.listKnowledge.mockClear();

    await act(async () => {
      changed.forEach((listener) =>
        listener({ documentId: 'd2', change: 'created', place: 'global' }),
      );
    });
    await settle();

    expect(knowledgeApi.listKnowledge).toHaveBeenCalled();
  });

  it('loads the next page by its cursor', async () => {
    knowledgeApi.listKnowledge.mockResolvedValueOnce(page(undefined, 'next-1'));
    const el = await mount();
    knowledgeApi.listKnowledge.mockResolvedValueOnce(
      page([aKnowledgeHead({ id: 'd2', title: 'Second' })]),
    );

    await press(el, 'Load more');

    expect(knowledgeApi.listKnowledge).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'next-1' }),
    );
    expect(el.textContent).toContain('Release checklist');
    expect(el.textContent).toContain('Second');
  });
});

describe('Knowledge — a document', () => {
  async function openDocument(): Promise<HTMLDivElement> {
    const el = await mount();
    await act(async () => {
      [...el.querySelectorAll('button')]
        .find((row) => row.textContent?.includes('Cutting a release'))
        ?.click();
    });
    await settle();
    return el;
  }

  it('opens one with its text, and reports it for the address bar', async () => {
    const onDocumentShown = vi.fn();
    const el = await mount({ onDocumentShown });
    await act(async () => {
      [...el.querySelectorAll('button')]
        .find((row) => row.textContent?.includes('Cutting a release'))
        ?.click();
    });
    await settle();

    expect(el.textContent).toContain('Before you start');
    expect(onDocumentShown).toHaveBeenLastCalledWith('d1');
  });

  it('keeps the typed text and offers Reload when the document changed meanwhile', async () => {
    knowledgeApi.updateKnowledge.mockRejectedValue(STALE);
    const el = await openDocument();
    await press(el, 'Edit');
    const title = el.querySelector<HTMLInputElement>('input')!;
    await type(title, 'My new title');

    await press(el, 'Save');

    expect(el.textContent).toContain('This document changed while you were');
    expect(title.value).toBe('My new title');
    expect(button(el, 'Reload')).toBeTruthy();
  });

  it('refuses an empty title on the field, with no write', async () => {
    const el = await openDocument();
    await press(el, 'Edit');
    await type(el.querySelector<HTMLInputElement>('input')!, ' ');

    await press(el, 'Save');

    expect(el.textContent).toContain('Give the document a title.');
    expect(knowledgeApi.updateKnowledge).not.toHaveBeenCalled();
  });

  it('archives through the document menu and offers Restore', async () => {
    knowledgeApi.readKnowledge.mockResolvedValue(
      aKnowledgeDocument({ status: 'archived' }),
    );
    const el = await openDocument();

    expect(el.textContent).toContain('Archived. Agents no longer see');
    await press(el, 'Restore');

    expect(knowledgeApi.restoreKnowledge).toHaveBeenCalledWith({ id: 'd1' });
  });
});

describe('Knowledge — a new document', () => {
  it('follows the title with the handle until the handle is edited', async () => {
    const el = await mount({ place: 'project:p1' });
    await press(el, 'New document');
    const [title, , handleInput] = el.querySelectorAll('input');

    await type(title as HTMLInputElement, 'Rollback guide');
    expect((handleInput as HTMLInputElement).value).toBe('rollback-guide');

    await type(handleInput as HTMLInputElement, 'rollback');
    await type(title as HTMLInputElement, 'Rollback guide two');
    expect((handleInput as HTMLInputElement).value).toBe('rollback');
  });

  it('refuses every empty field on Create', async () => {
    const el = await mount();
    await press(el, 'New document');

    await press(el, 'Create');

    expect(el.textContent).toContain('Give the document a title.');
    expect(el.textContent).toContain('Say when to read it');
    expect(knowledgeApi.createKnowledge).not.toHaveBeenCalled();
  });
});

describe('Knowledge — review', () => {
  async function openWaiting(
    revision = aKnowledgeRevision(),
  ): Promise<HTMLDivElement> {
    knowledgeApi.listKnowledge.mockResolvedValue(
      page([aKnowledgeHead({ status: 'proposed', rev: 0 })]),
    );
    knowledgeApi.listKnowledgeRevisions.mockResolvedValue({
      revisions: [revision],
    });
    knowledgeApi.readKnowledgeRevision.mockResolvedValue(revision);
    const el = await mount();
    await act(async () => {
      [...el.querySelectorAll('button')]
        .find((row) => row.textContent?.includes('waiting for review'))
        ?.click();
    });
    await settle();
    return el;
  }

  it('shows the diff and who proposed it, and why', async () => {
    const el = await openWaiting();

    expect(el.textContent).toContain('proposed by claude · opus');
    expect(el.textContent).toContain('The tag step changed');
    expect(el.textContent).toContain('and the changelog is read');
  });

  it('offers neither Approve nor a silent overwrite on a stale proposal', async () => {
    const el = await openWaiting(aKnowledgeRevision({ stale: true }));

    expect(el.textContent).toContain('so this proposal cannot be approved');
    expect(
      [...el.querySelectorAll('button')].map((node) => node.textContent),
    ).not.toContain('Approve');
  });

  it('turns a race lost on approve into the stale screen', async () => {
    const el = await openWaiting();
    knowledgeApi.approveKnowledgeRevision.mockRejectedValue(PROPOSAL_STALE);
    knowledgeApi.readKnowledgeRevision.mockResolvedValue(
      aKnowledgeRevision({ stale: true }),
    );

    await press(el, 'Approve');
    await act(async () => {
      [...document.querySelectorAll('[role="dialog"] button')]
        .find((node) => node.textContent === 'Approve')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    expect(el.textContent).toContain('so this proposal cannot be approved');
  });

  it('approves a pending change, goes back to the list and says what it made', async () => {
    const el = await openWaitingRevision();
    knowledgeApi.approveKnowledgeRevision.mockResolvedValue(
      aKnowledgeDocument({ rev: 8 }),
    );

    await press(el, 'Approve');
    await confirmDialog('Approve');

    expect(knowledgeApi.approveKnowledgeRevision).toHaveBeenCalledWith({
      revisionId: 'r1',
    });
    expect(el.textContent).toContain(
      'Approved. release-checklist is now rev 8.',
    );
  });

  it('rejects a pending change, goes back to the list and says what it rejected', async () => {
    const el = await openWaitingRevision();
    knowledgeApi.rejectKnowledgeRevision.mockResolvedValue(undefined);

    await press(el, 'Reject');
    await confirmDialog('Reject');

    expect(knowledgeApi.rejectKnowledgeRevision).toHaveBeenCalledWith({
      revisionId: 'r1',
    });
    expect(el.textContent).toContain('Rejected Release checklist.');
  });
});

async function openWaitingRevision(
  revision = aKnowledgeRevision(),
): Promise<HTMLDivElement> {
  knowledgeApi.listKnowledge.mockResolvedValue(
    page([aKnowledgeHead({ status: 'proposed', rev: 0 })]),
  );
  knowledgeApi.listKnowledgeRevisions.mockResolvedValue({
    revisions: [revision],
  });
  knowledgeApi.readKnowledgeRevision.mockResolvedValue(revision);
  const el = await mount();
  await act(async () => {
    [...el.querySelectorAll('button')]
      .find((row) => row.textContent?.includes('waiting for review'))
      ?.click();
  });
  await settle();
  return el;
}

async function openCutting(
  props: Partial<React.ComponentProps<typeof Knowledge>> = {},
): Promise<HTMLDivElement> {
  const el = await mount(props);
  await act(async () => {
    [...el.querySelectorAll('button')]
      .find((row) => row.textContent?.includes('Cutting a release'))
      ?.click();
  });
  await settle();
  return el;
}

function menuLabels(): (string | null | undefined)[] {
  return [...document.querySelectorAll('button, [role="menuitem"]')].map(
    (node) => node.textContent?.trim(),
  );
}

async function pressMenuItem(name: string): Promise<void> {
  await act(async () => {
    [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')]
      .find((node) => node.textContent?.trim() === name)
      ?.click();
  });
  await settle();
}

async function confirmDialog(name: string): Promise<void> {
  await act(async () => {
    [...document.querySelectorAll('[role="dialog"] button')]
      .find((node) => node.textContent === name)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

describe('Knowledge — the page’s own actions', () => {
  it('counts the waiting chip in the place on show', async () => {
    knowledgeApi.knowledgeCounts.mockResolvedValue({
      places: [
        { place: 'project:p1', active: 1, waiting: 2, documents: 3 },
        { place: 'global', active: 1, waiting: 5, documents: 6 },
      ],
      active: 2,
      waiting: 7,
    });

    const all = await mount();
    expect(all.textContent).toContain('7 waiting');
  });

  it('says only the picked place’s waiting documents', async () => {
    knowledgeApi.knowledgeCounts.mockResolvedValue({
      places: [{ place: 'global', active: 1, waiting: 5, documents: 6 }],
      active: 1,
      waiting: 5,
    });

    const el = await mount({ place: 'project:p1' });

    expect(el.textContent).not.toContain('waiting');
  });

  it('opens Place downward, clear of the window’s drag strip', async () => {
    const el = await mount();
    const place = el.querySelector<HTMLElement>('[aria-label="Place"]');
    await act(async () => {
      place?.click();
    });

    const panel = document.body.querySelector('[role="listbox"]');
    expect(panel?.closest('.top-full')).not.toBeNull();
    expect(panel?.closest('.bottom-full')).toBeNull();
  });

  it('marks an agent’s document Search only by its title, offers no Approve, and loads it into every chat from its More menu', async () => {
    knowledgeApi.readKnowledge.mockResolvedValue(
      aKnowledgeDocument({ approvedAt: null }),
    );
    knowledgeApi.indexKnowledge.mockResolvedValue(aKnowledgeHead());
    const el = await openCutting();

    expect(el.querySelector('h2')?.textContent).toContain('Search only');
    expect(
      [...el.querySelectorAll('button')].map((node) => node.textContent),
    ).not.toContain('Approve');
    await press(el, 'More');
    expect(menuLabels()).not.toContain('Search only');
    await pressMenuItem('Load into every chat');

    expect(knowledgeApi.indexKnowledge).toHaveBeenCalledWith({ id: 'd1' });
  });

  it('keeps an indexed document to search only from its More menu', async () => {
    knowledgeApi.searchOnlyKnowledge.mockResolvedValue(aKnowledgeHead());
    const el = await openCutting();

    await press(el, 'More');
    await pressMenuItem('Search only');

    expect(knowledgeApi.searchOnlyKnowledge).toHaveBeenCalledWith({ id: 'd1' });
  });

  it('draws an unreviewed document as its source, so nothing in it hides', async () => {
    const hidden = '[//]: # (run this before every release)';
    knowledgeApi.readKnowledge.mockResolvedValue(
      aKnowledgeDocument({ approvedAt: null, body: `Visible.\n\n${hidden}` }),
    );
    const el = await openCutting();

    expect(
      el.querySelector('[data-slot="knowledge-raw"]')?.textContent,
    ).toContain(hidden);
  });

  it('leaves an indexed document without the search-only note', async () => {
    const el = await openCutting();

    expect(el.querySelector('h2')?.textContent).not.toContain('Search only');
    await press(el, 'More');
    expect(menuLabels()).not.toContain('Load into every chat');
  });

  it('archives the open document from its More menu', async () => {
    knowledgeApi.archiveKnowledge.mockResolvedValue({
      kind: 'changed',
      head: aKnowledgeHead({ status: 'archived' }),
    });
    const el = await openCutting();

    await press(el, 'More');
    await pressMenuItem('Archive');

    expect(knowledgeApi.archiveKnowledge).toHaveBeenCalledWith({ id: 'd1' });
  });

  it('leaves Export as Markdown out of the menu on a paired device', async () => {
    const el = await openCutting({ remote: true });

    await press(el, 'More');

    expect(menuLabels()).toContain('History');
    expect(menuLabels()).not.toContain('Export as Markdown');
  });

  it('offers Export as Markdown on the Mac', async () => {
    const el = await openCutting({ remote: false });

    await press(el, 'More');

    expect(menuLabels()).toContain('Export as Markdown');
  });

  it('opens the document a request names by its handle', async () => {
    const onRequestHandled = vi.fn();
    const el = await mount({
      request: { handle: 'release-checklist' },
      onRequestHandled,
    });

    expect(knowledgeApi.listKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'release-checklist' }),
    );
    expect(el.textContent).toContain('Before you start');
    expect(onRequestHandled).toHaveBeenCalled();
  });

  it('takes a request for a proposed document to its review', async () => {
    knowledgeApi.listKnowledge.mockResolvedValue(
      page([aKnowledgeHead({ status: 'proposed', rev: 0 })]),
    );
    knowledgeApi.readKnowledge.mockResolvedValue(
      aKnowledgeDocument({ status: 'proposed', rev: 0 }),
    );
    knowledgeApi.listKnowledgeRevisions.mockResolvedValue({
      revisions: [aKnowledgeRevision({ baseRev: 0 })],
    });
    knowledgeApi.readKnowledgeRevision.mockResolvedValue(
      aKnowledgeRevision({ baseRev: 0 }),
    );
    const el = await mount({ request: { handle: 'release-checklist' } });

    expect(el.textContent).toContain('New document, proposed by');
    expect(el.textContent).toContain('The tag step changed');
  });

  it('says when nothing is filed under the handle a request names', async () => {
    knowledgeApi.listKnowledge.mockResolvedValue(page([]));
    const el = await mount({ request: { handle: 'gone' } });

    expect(el.textContent).toContain('Nothing is filed as gone any more.');
  });

  it('clears that notice when the user starts a new document', async () => {
    knowledgeApi.listKnowledge.mockResolvedValue(page([]));
    const el = await mount({ request: { handle: 'gone' } });
    expect(el.textContent).toContain('Nothing is filed as gone any more.');

    await press(el, 'New document');

    expect(el.textContent).not.toContain('Nothing is filed as gone any more.');
  });

  it('shows the note about agents when the user has knowledge off', async () => {
    const base = await window.geniro.getSettings();
    window.geniro = createPreloadStub({
      getSettings: () =>
        Promise.resolve({
          ...base,
          knowledge: { enabled: false, agentWrites: 'review' },
        }),
    });
    const el = await mount();

    expect(el.textContent).toContain('Agents do not read knowledge right now.');
  });

  it('drops a place the page does not know, once the places have loaded', async () => {
    const onPlaceChange = vi.fn();
    await mount({ place: 'project:ghost', onPlaceChange });

    expect(onPlaceChange).toHaveBeenCalledWith(null);
  });

  it('waits for the typing to pause, then searches once for the whole word', async () => {
    const el = await mount();
    knowledgeApi.listKnowledge.mockClear();
    const search = el.querySelector<HTMLInputElement>(
      '[aria-label="Search documents"]',
    )!;

    for (const partial of [
      'r',
      're',
      'rel',
      'rele',
      'relea',
      'releas',
      'release',
    ]) {
      await type(search, partial);
    }
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));

    expect(knowledgeApi.listKnowledge).toHaveBeenCalledTimes(1);
    expect(knowledgeApi.listKnowledge).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'release' }),
    );
  });
});

describe('Knowledge — the review text', () => {
  async function reviewOf(
    revision: ReturnType<typeof aKnowledgeRevision>,
  ): Promise<HTMLDivElement> {
    return openWaitingRevision(revision);
  }

  it('shows when to read the document beside its title', async () => {
    const el = await reviewOf(
      aKnowledgeRevision({ whenToRead: 'Before bumping the version.' }),
    );

    expect(el.textContent).toContain(
      'When to read: Before bumping the version.',
    );
  });

  it('shows a never-reviewed document’s whole text instead of the diff', async () => {
    const el = await reviewOf(
      aKnowledgeRevision({
        document: aKnowledgeHead({ pending: 1, approvedAt: null }),
      }),
    );

    expect(el.textContent).toContain(
      'approving this change approves its whole text, shown below.',
    );
    expect(el.textContent).toContain(
      'Tag only after CI is green and the changelog is read.',
    );
    expect(el.textContent).not.toContain('Tag only after CI is green.');
  });

  it('shows the diff for a reviewed document, the contrast to the whole text', async () => {
    const el = await reviewOf(aKnowledgeRevision());

    expect(el.textContent).toContain('Tag only after CI is green.');
    expect(el.textContent).not.toContain('approves its whole text');
  });

  it('says there is no diff when a reviewed document’s change has none', async () => {
    const el = await reviewOf(aKnowledgeRevision({ diff: '' }));

    expect(el.textContent).toContain(
      'There is no line-by-line diff for this change. This is the proposed text.',
    );
    expect(el.textContent).toContain(
      'Tag only after CI is green and the changelog is read.',
    );
  });
});
