import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ChangedFileSummary, DiffManifest, DiffScope } from '../../../../../shared/types/gitDiff';
import type { CombinedDiffViewProps, ExecutionDiff } from '../../../types/diff';
import { API } from '../../../utils/api';
import ExecutionList from '../../ExecutionList';
import { CommitDialog } from '../../CommitDialog';
import { editorPanelState, openFileInEditor } from '../../../services/openFileInEditor';
import { usePanelStore } from '../../../stores/panelStore';
import { ChangesTree } from './ChangesTree';
import { defaultExpanded, reconcileExpanded } from './changesTreeModel';
import { editorDiffRefForFile, isMutableScope, scopeKey, scopeLabel } from './diffScope';
import { buildChangesTree, compactChains } from './changesTreeModel';
import { clearPendingViewCommit, takePendingViewCommit } from './pendingViewCommit';

const HISTORY_LIMIT = 50;

export interface CombinedDiffViewHandle { refresh: () => void }

const CombinedDiffView = memo(forwardRef<CombinedDiffViewHandle, CombinedDiffViewProps>(function CombinedDiffView({
  sessionId,
  isGitOperationRunning = false,
  isMainRepo = false,
  isVisible = true,
}, ref) {
  const [executions, setExecutions] = useState<ExecutionDiff[]>([]);
  const [scope, setScope] = useState<DiffScope>({ kind: 'session' });
  const [manifest, setManifest] = useState<DiffManifest | null>(null);
  const [loading, setLoading] = useState(false);
  const [executionsLoading, setExecutionsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [expandedByScope, setExpandedByScope] = useState<Record<string, Set<string>>>({});
  const manifestCache = useRef(new Map<string, DiffManifest>());
  const requestId = useRef(0);
  const executionRequestId = useRef(0);
  const displayedKey = useRef<string | null>(null);

  const key = `${sessionId}:${scopeKey(scope)}`;
  const expanded = expandedByScope[key] ?? new Set<string>();
  const visibleManifest = displayedKey.current === key ? manifest : null;

  const activeDiffPath = usePanelStore((state) => {
    const activeId = state.activePanels[sessionId];
    const active = (state.panels[sessionId] || []).find(panel => panel.id === activeId);
    const editor = active ? editorPanelState(active) : undefined;
    return editor?.diff ? editor.filePath : null;
  });

  const refresh = useCallback(() => {
    for (const cacheKey of manifestCache.current.keys()) {
      if (cacheKey.startsWith(`${sessionId}:`)) manifestCache.current.delete(cacheKey);
    }
    requestId.current += 1;
    setRefreshNonce(value => value + 1);
  }, [sessionId]);

  useImperativeHandle(ref, () => ({ refresh }), [refresh]);

  useEffect(() => {
    setScope({ kind: 'session' });
    setManifest(null);
    setExecutions([]);
    setExpandedByScope({});
    manifestCache.current.clear();
    requestId.current += 1;
    executionRequestId.current += 1;
    displayedKey.current = null;
  }, [sessionId]);

  useEffect(() => {
    if (!isVisible) return;
    const owned = ++executionRequestId.current;
    setExecutionsLoading(true);
    void API.sessions.getExecutions(sessionId).then(response => {
      if (owned !== executionRequestId.current) return;
      if (!response.success) throw new Error(response.error || 'Failed to load commits');
      setExecutions(response.data ?? []);
    }).catch(cause => {
      if (owned === executionRequestId.current) setError(cause instanceof Error ? cause.message : 'Failed to load commits');
    }).finally(() => {
      if (owned === executionRequestId.current) setExecutionsLoading(false);
    });
  }, [isVisible, refreshNonce, sessionId]);

  useEffect(() => {
    const pending = takePendingViewCommit(sessionId);
    if (pending !== null) setScope(pending === 'index' ? { kind: 'working-tree' } : { kind: 'commit', hash: pending });
    const handler = (event: Event) => {
      // SAFETY: This listener is registered only for the app-owned diff:view-commit event.
      const detail = (event as CustomEvent<{ sessionId: string; commitHash: string }>).detail;
      if (detail.sessionId !== sessionId) return;
      setScope(detail.commitHash === 'index' ? { kind: 'working-tree' } : { kind: 'commit', hash: detail.commitHash });
      clearPendingViewCommit();
    };
    window.addEventListener('diff:view-commit', handler);
    return () => window.removeEventListener('diff:view-commit', handler);
  }, [sessionId]);

  useEffect(() => {
    if (!isVisible) return;
    const owned = ++requestId.current;
    const cached = manifestCache.current.get(key);
    if (cached && (!isMutableScope(scope) || refreshNonce === 0)) {
      setManifest(cached);
      displayedKey.current = key;
      setError(null);
      return;
    }
    if (displayedKey.current !== key) setManifest(null);
    setLoading(true);
    setError(null);
    void API.sessions.getDiffManifest(sessionId, scope).then(response => {
      if (owned !== requestId.current) return;
      if (!response.success || !response.data) throw new Error(response.error || 'Failed to load changes');
      const data = response.data;
      manifestCache.current.set(key, data);
      setManifest(data);
      displayedKey.current = key;
      const tree = compactChains(buildChangesTree(data.files));
      setExpandedByScope(previous => ({
        ...previous,
        [key]: previous[key] ? reconcileExpanded(previous[key], tree) : defaultExpanded(tree),
      }));
    }).catch(cause => {
      if (owned === requestId.current) setError(cause instanceof Error ? cause.message : 'Failed to load changes');
    }).finally(() => {
      if (owned === requestId.current) setLoading(false);
    });
  }, [isVisible, key, refreshNonce, scope, sessionId]);

  const selection = useMemo((): { kind: 'all' } | { kind: 'ids'; ids: number[] } => {
    if (scope.kind === 'session') return { kind: 'all' };
    if (scope.kind === 'working-tree') return { kind: 'ids', ids: [0] };
    const byHash = new Map(executions.map(execution => [execution.after_commit_hash, execution.id]));
    if (scope.kind === 'commit') return { kind: 'ids', ids: [byHash.get(scope.hash) ?? -1].filter(id => id >= 0) };
    if (scope.kind === 'commit-range') return { kind: 'ids', ids: [byHash.get(scope.olderHash), byHash.get(scope.newerHash)].filter((id): id is number => id !== undefined) };
    return { kind: 'ids', ids: [0, byHash.get(scope.baseHash)].filter((id): id is number => id !== undefined) };
  }, [executions, scope]);

  const selectIds = useCallback((ids: number[]) => {
    if (ids.length === 0) return;
    const byId = new Map(executions.map(execution => [execution.id, execution]));
    if (ids.length === 1) {
      const id = ids[0];
      if (id === 0) setScope({ kind: 'working-tree' });
      else {
        const hash = byId.get(id)?.after_commit_hash;
        if (hash) setScope({ kind: 'commit', hash });
      }
      return;
    }
    if (ids.includes(0)) {
      const commitId = ids.find(id => id !== 0);
      const hash = commitId === undefined ? undefined : byId.get(commitId)?.after_commit_hash;
      if (hash) setScope({ kind: 'working-tree-range', baseHash: hash });
      return;
    }
    const olderId = Math.max(...ids);
    const newerId = Math.min(...ids);
    const olderHash = byId.get(olderId)?.after_commit_hash;
    const newerHash = byId.get(newerId)?.after_commit_hash;
    if (olderHash && newerHash) setScope({ kind: 'commit-range', olderHash, newerHash });
  }, [executions]);

  const handleFileOpen = useCallback((file: ChangedFileSummary, pin: boolean) => {
    void openFileInEditor({ sessionId, filePath: file.path, pin, diff: editorDiffRefForFile(scope, file) });
  }, [scope, sessionId]);

  const handleCommit = useCallback(async (message: string) => {
    const response = await window.electronAPI.invoke('git:commit', { sessionId, message });
    if (!response.success) throw new Error(response.error || 'Failed to commit changes');
    refresh();
  }, [refresh, sessionId]);

  const handleRevert = useCallback(async (commitHash: string) => {
    if (!window.confirm(`Revert commit ${commitHash.slice(0, 7)}?`)) return;
    const response = await window.electronAPI.invoke('git:revert', { sessionId, commitHash });
    if (!response.success) throw new Error(response.error || 'Failed to revert commit');
    refresh();
  }, [refresh, sessionId]);

  const handleRestore = useCallback(async () => {
    if (!window.confirm('Restore all uncommitted changes?')) return;
    const response = await window.electronAPI.invoke('git:restore', { sessionId });
    if (!response.success) throw new Error(response.error || 'Failed to restore changes');
    refresh();
  }, [refresh, sessionId]);

  const label = scopeLabel(scope, { ref: visibleManifest?.resolvedBase.ref });
  const busy = loading || executionsLoading || isGitOperationRunning;
  const historyLimitReached = executions.some(execution => execution.history_limit_reached);

  return (
    <div className="combined-diff-view flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border-primary bg-surface-secondary px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium text-text-secondary">{label}</span>
          {visibleManifest && <div className="flex flex-shrink-0 items-center gap-2 text-xs"><span className="font-semibold text-status-success">+{visibleManifest.stats.additions}</span><span className="font-semibold text-status-error">-{visibleManifest.stats.deletions}</span><span className="text-text-muted">{visibleManifest.stats.filesChanged}f</span></div>}
        </div>
        <button type="button" onClick={refresh} disabled={busy} className="rounded p-1 hover:bg-surface-hover" title="Refresh"><RefreshCw className={`h-3.5 w-3.5 text-text-tertiary ${busy ? 'animate-spin' : ''}`} /></button>
      </div>
      <div className="pane-review-split flex min-h-0 flex-1">
        <div className="pane-review-list flex w-[300px] flex-shrink-0 flex-col overflow-hidden border-r border-border-primary bg-surface-secondary">
          <ExecutionList sessionId={sessionId} executions={executions} selection={selection} onSelectAll={() => setScope({ kind: 'session' })} onSelectionChange={selectIds} onCommit={() => setShowCommitDialog(true)} onRevert={handleRevert} onRestore={handleRestore} historyLimitReached={historyLimitReached} historyLimit={HISTORY_LIMIT} />
        </div>
        <div className="diff-panel flex min-w-0 flex-1 flex-col overflow-hidden bg-bg-primary">
          {loading && !visibleManifest ? <div className="animate-pulse p-4 text-sm text-text-secondary">Loading {label}…</div>
            : error ? <div role="alert" className="m-4 rounded border border-status-error/30 bg-status-error/10 p-4 text-sm text-status-error">{error}</div>
              : visibleManifest && visibleManifest.files.length > 0 ? <ChangesTree sessionId={sessionId} manifest={visibleManifest} scopeKey={scopeKey(scope)} activePath={activeDiffPath} expanded={expanded} onExpandedChange={next => setExpandedByScope(previous => ({ ...previous, [key]: next }))} onFileOpen={handleFileOpen} />
                : <div className="flex h-full items-center justify-center text-sm text-text-secondary">No changes to review</div>}
        </div>
      </div>
      <CommitDialog isOpen={showCommitDialog} onClose={() => setShowCommitDialog(false)} onCommit={handleCommit} fileCount={visibleManifest?.stats.filesChanged ?? 0} />
      {isMainRepo && <span className="sr-only">Main repository changes</span>}
    </div>
  );
}));

CombinedDiffView.displayName = 'CombinedDiffView';
export default CombinedDiffView;
