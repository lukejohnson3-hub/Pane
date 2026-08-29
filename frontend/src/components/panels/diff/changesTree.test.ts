import { describe, expect, it } from 'vitest';
import type { ChangedFileSummary } from '../../../../../shared/types/gitDiff';
import { buildChangesTree, compactChains, defaultExpanded, flattenRows, navigate, revealPath, typeAhead } from './changesTreeModel';

const file = (path: string): ChangedFileSummary => ({ path, kind: 'modified', additions: 1, deletions: 1, isBinary: false });

describe('changes tree model', () => {
  it('sorts folders first, compacts chains, and keeps same-basename files distinct', () => {
    const tree = compactChains(buildChangesTree([file('z.ts'), file('a/b/c.ts'), file('x/c.ts')]));
    const rows = flattenRows(tree, defaultExpanded(tree));
    expect(rows.map(row => row.fullPath)).toEqual(['a/b', 'a/b/c.ts', 'x', 'x/c.ts', 'z.ts']);
    expect(rows.filter(row => row.label === 'c.ts')).toHaveLength(2);
    expect(rows[0].changedCount).toBe(1);
  });

  it('reveals ancestors and implements standard navigation plus type-ahead wraparound', () => {
    const tree = buildChangesTree([file('a/one.ts'), file('b/two.ts')]);
    const collapsed = new Set<string>();
    const revealed = revealPath(collapsed, tree, 'b/two.ts');
    expect(revealed.has('d:b')).toBe(true);
    const rows = flattenRows(tree, defaultExpanded(tree));
    expect(navigate(rows, 0, 'End', revealed).activeIndex).toBe(rows.length - 1);
    expect(navigate(rows, 1, 'ArrowUp', revealed).activeIndex).toBe(0);
    expect(typeAhead(rows, rows.length - 1, 'a')).toBe(0);
  });
});
