import { expect, test, type Page } from '@playwright/test';
import type { DiffManifest } from '../shared/types/gitDiff';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';
import { expectNoAxeViolations } from './axeTest';

const project = { id: 812, name: 'Tree fixture', path: '/tmp/tree-fixture', active: true, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
const session = { id: 'tree-session', name: 'Changes tree', worktreePath: '/tmp/tree-fixture/worktree', status: 'stopped', createdAt: new Date(0).toISOString(), lastActivity: new Date(0).toISOString(), output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', projectId: project.id, displayOrder: 0, isFavorite: false, toolType: 'none', archived: false, gitStatus: { state: 'modified', ahead: 1, behind: 0, hasUncommittedChanges: true, hasUntrackedFiles: false, filesChanged: 4, additions: 6, deletions: 2, totalCommits: 1 } };
const panels = [
  { id: 'tree-terminal', sessionId: session.id, type: 'terminal', title: 'Terminal', state: { isActive: true, hasBeenViewed: true, customState: { isInitialized: false } }, metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 0, permanent: true } },
  { id: 'tree-diff', sessionId: session.id, type: 'diff', title: 'Diff', state: { isActive: false, hasBeenViewed: true }, metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 1, permanent: true } },
];
const manifest: DiffManifest = {
  scope: { kind: 'session' },
  files: [
    { path: 'src/components/Alpha.tsx', kind: 'modified', additions: 2, deletions: 1, isBinary: false },
    { path: 'src/components/Beta.tsx', previousPath: 'src/legacy/Beta.tsx', kind: 'renamed', additions: 0, deletions: 0, isBinary: false },
    { path: 'src/deleted.ts', kind: 'deleted', additions: 0, deletions: 1, isBinary: false },
    { path: 'README.md', kind: 'added', additions: 4, deletions: 0, isBinary: false },
  ],
  resolvedBase: { kind: 'comparison-base', ref: 'main', hash: '1111111111111111111111111111111111111111' },
  resolvedTarget: { kind: 'working-tree' },
  stats: { additions: 6, deletions: 2, filesChanged: 4 },
};

async function openTree(page: Page, options: { executions?: JsonObject[]; manifests?: Record<string, DiffManifest>; delays?: Record<string, number> } = {}): Promise<void> {
  await installElectronApiMock(page, { initialProjects: [project], initialSessions: [session], initialPanels: panels, initialExecutions: options.executions ?? [], diffManifests: options.manifests ?? { session: manifest }, diffManifestDelayMs: options.delays, initialUiState: { expandedProjects: [project.id] }, activeProjectId: project.id });
  await page.goto('/');
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Changed files' })).toBeVisible();
}

test('hierarchy, keyboard navigation, and tree-only controls remain accessible', async ({ page }) => {
  await openTree(page);
  const tree = page.getByRole('tree', { name: 'Changed files' });
  await expect(page.getByRole('treeitem', { name: 'Open diff for README.md' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Open diff for src/components/Alpha.tsx' })).toBeVisible();
  await tree.focus();
  await tree.press('End');
  await tree.press('Home');
  await tree.press('s');
  await tree.press('ArrowRight');
  await expect(tree).toHaveAttribute('aria-activedescendant', /changes-tree/);
  await expect(page.getByText(/stage|unstage|list view|tree view/i)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoAxeViolations(page, { include: '.combined-diff-view' });
});

test('file activation opens an All changes diff tab and marks selection separately', async ({ page }) => {
  await openTree(page);
  const file = page.getByRole('treeitem', { name: 'Open diff for src/components/Alpha.tsx' });
  await file.click();
  await expect(page.getByRole('tab', { name: 'Alpha.tsx (All changes)' })).toHaveAttribute('aria-selected', 'true');
  await expect(file).toHaveAttribute('aria-selected', 'true');
});

test('a late commit manifest cannot replace a restored All changes scope', async ({ page }) => {
  const hash = 'abcdef0123456789abcdef0123456789abcdef01';
  const commitManifest: DiffManifest = { ...manifest, scope: { kind: 'commit', hash }, files: [{ path: 'commit-only.ts', kind: 'modified', additions: 1, deletions: 0, isBinary: false }], stats: { additions: 1, deletions: 0, filesChanged: 1 } };
  await openTree(page, {
    executions: [{ id: 1, session_id: session.id, execution_sequence: 1, after_commit_hash: hash, commit_message: 'Commit scope', timestamp: new Date(0).toISOString(), stats_additions: 1, stats_deletions: 0, stats_files_changed: 1 }],
    manifests: { session: manifest, [`commit:${hash}`]: commitManifest },
    delays: { [`commit:${hash}`]: 120 },
  });
  await page.getByRole('button', { name: 'Select Commit scope' }).click();
  await page.waitForTimeout(20);
  await page.getByRole('button', { name: 'All changes' }).click();
  await page.waitForTimeout(150);
  await expect(page.getByRole('treeitem', { name: 'Open diff for README.md' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Open diff for commit-only.ts' })).toHaveCount(0);
});
