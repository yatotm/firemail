import type { Account } from '@firemail/shared';
import {
  CheckCircle2Icon,
  ImportIcon,
  KeyRoundIcon,
  PlusIcon,
  SearchXIcon,
  UsersIcon,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { AccountsTable } from '@/components/accounts/accounts-table';
import { AccountsToolbar } from '@/components/accounts/accounts-toolbar';
import { BulkActionBar } from '@/components/accounts/bulk-action-bar';
import { ExportCredentialsDialog } from '@/components/accounts/export-credentials-dialog';
import { HealthStats } from '@/components/accounts/health-stats';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorBanner, ErrorState } from '@/components/common/error-state';
import { TableSkeleton } from '@/components/common/skeletons';
import { Button } from '@/components/ui/button';
import { useAccountActions } from '@/hooks/accounts/use-account-actions';
import { useAccountFilters } from '@/hooks/accounts/use-account-filters';
import { useAccountEditor } from '@/hooks/accounts/use-account-editor';
import { useAccounts } from '@/hooks/use-accounts';
import { useAuth } from '@/hooks/use-auth';
import { useRegisterCommands } from '@/hooks/use-commands';
import { useServerEvent, useServerEvents } from '@/hooks/use-server-events';
import { useShortcuts, useShortcutScope } from '@/hooks/use-shortcuts';
import { patchAccountsInCache } from '@/lib/accounts/cache';
import { queryKeys } from '@/lib/query-keys';
import {
  countByStatus,
  filterAccounts,
  hasActiveFilters,
  repairAction,
  sortAccounts,
  syncableAccounts,
} from '@/lib/accounts/dashboard';
import { ACCOUNT_STATUS_META } from '@/lib/account-status';

export interface AccountsOutletContext {
  accounts: Account[];
  reload: () => void;
}

/**
 * 账号管理 / 健康仪表盘（`/accounts`）。
 *
 * 这个屏幕的首要任务是**一眼看出哪些账号的授权坏了，并就地修好**：
 * 统计块可点即筛选，坏账号默认排在最前，修复按钮长在出问题的那一行上。
 * `auth_error` 用琥珀色（用户自己能修），`error` 用红色（系统性故障），两者不混用一个红。
 */
export function AccountsPage() {
  const accountsQuery = useAccounts();
  const { filters, setFilters, resetFilters, sort, toggleSortKey } = useAccountFilters();
  const actions = useAccountActions();
  const editor = useAccountEditor();
  const { syncingAccountIds } = useServerEvents();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  const { user } = useAuth();

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(() => new Set());
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Account[]>([]);
  const [exportOpen, setExportOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());

  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const counts = useMemo(() => countByStatus(accounts), [accounts]);
  const visible = useMemo(
    () => sortAccounts(filterAccounts(accounts, filters), sort),
    [accounts, filters, sort],
  );
  const selected = useMemo(
    () => accounts.filter((account) => selectedIds.has(account.id)),
    [accounts, selectedIds],
  );

  const overlayOpen = location.pathname !== '/accounts';

  const openDetail = useCallback(
    (account: Account) => void navigate(`/accounts/${account.id}`),
    [navigate],
  );

  const openReauth = useCallback(
    (account: Account) => void navigate(`/accounts/${account.id}/reauth`),
    [navigate],
  );

  const repair = useCallback(
    (account: Account) => {
      switch (repairAction(account)) {
        case 'reauth':
          openReauth(account);
          break;
        case 'credentials':
          openDetail(account);
          break;
        case 'test':
          void editor.test(account.id).catch(() => undefined);
          break;
        case 'enable':
          actions.setEnabled([account], true);
          break;
        case null:
          openDetail(account);
          break;
      }
    },
    [actions, editor, openDetail, openReauth],
  );

  const toggleSelect = useCallback((account: Account) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(account.id)) next.delete(account.id);
      else next.add(account.id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((current) => {
      const allSelected = visible.length > 0 && visible.every((item) => current.has(item.id));
      return allSelected ? new Set() : new Set(visible.map((item) => item.id));
    });
  }, [visible]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const focusRow = useCallback(
    (offset: number) => {
      if (visible.length === 0) return;
      const index = visible.findIndex((account) => account.id === focusedId);
      const nextIndex = index === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, index + offset));
      const target = visible[nextIndex];
      if (target) rowRefs.current.get(target.id)?.focus();
    },
    [focusedId, visible],
  );

  /**
   * SSE 对账：外壳已经在 `account:status` 时 invalidate 了账号列表，
   * 这里再补两件它做不了的事 —— 用事件里的状态先把这一行改掉（不等 refetch 往返），
   * 以及在 `sync:done` 后刷新「上次同步 / 未读」两列（外壳只刷了 summary）。
   */
  useServerEvent((event) => {
    if (event.type === 'account:status') {
      patchAccountsInCache(queryClient, [event.accountId], { status: event.status });
      return;
    }
    if (event.type === 'sync:done' || event.type === 'sync:error') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
    }
  });

  useShortcutScope('list');
  useShortcuts([
    { keys: 'n', label: '添加账号', group: '系统', scope: 'list', run: () => void navigate('/accounts/new') },
    { keys: 'i', label: '批量导入账号', group: '系统', scope: 'list', run: () => void navigate('/accounts/import') },
    {
      keys: '/',
      label: '搜索账号',
      group: '搜索',
      scope: 'list',
      run: () => searchRef.current?.focus(),
    },
    { keys: 'j', label: '下一个账号', group: '导航', scope: 'list', run: () => focusRow(1) },
    { keys: 'k', label: '上一个账号', group: '导航', scope: 'list', run: () => focusRow(-1) },
    {
      keys: 'x',
      label: '勾选当前账号',
      group: '选择',
      scope: 'list',
      run: () => {
        const account = visible.find((item) => item.id === focusedId);
        if (account) toggleSelect(account);
      },
    },
    {
      keys: 'Mod+a',
      label: '全选当前列表',
      group: '选择',
      scope: 'list',
      run: () => setSelectedIds(new Set(visible.map((item) => item.id))),
    },
    {
      keys: 'Escape',
      label: '取消选择',
      group: '选择',
      scope: 'list',
      hidden: true,
      // 有浮层打开时让 Esc 归浮层，不然会一次关掉两样东西
      enabled: () => !overlayOpen && selectedIds.size > 0,
      run: clearSelection,
    },
    {
      keys: 'r',
      label: '同步选中的账号',
      group: '系统',
      scope: 'list',
      run: () => actions.syncNow(selected.length > 0 ? selected : syncableAccounts(accounts)),
    },
  ]);

  useRegisterCommands([
    {
      id: 'accounts.new',
      title: '添加账号',
      group: '账号',
      icon: PlusIcon,
      shortcut: 'n',
      run: () => void navigate('/accounts/new'),
    },
    {
      id: 'accounts.import',
      title: '批量导入账号',
      group: '账号',
      icon: ImportIcon,
      shortcut: 'i',
      keywords: ['plgr', 'import', '导入', '粘贴'],
      run: () => void navigate('/accounts/import'),
    },
    {
      id: 'accounts.syncAll',
      title: '同步全部账号',
      group: '账号',
      shortcut: 'r',
      run: () => actions.syncNow(syncableAccounts(accounts)),
    },
    {
      id: 'accounts.filterAuthError',
      title: `只看需重新授权的账号 (${counts.auth_error})`,
      group: '账号',
      run: () => setFilters({ status: 'auth_error' }),
    },
  ]);

  const loading = accountsQuery.isPending;
  const filtered = hasActiveFilters(filters);

  if (accountsQuery.isError && accounts.length === 0) {
    return (
      <div className="p-6">
        <ErrorState
          title="无法加载账号列表"
          error={accountsQuery.error}
          onRetry={() => void accountsQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <h1 className="flex-1 text-lg font-semibold">账号</h1>
        <Button size="sm" onClick={() => void navigate('/accounts/new')}>
          <PlusIcon aria-hidden />
          添加账号
        </Button>
        <Button variant="outline" size="sm" onClick={() => void navigate('/accounts/import')}>
          <ImportIcon aria-hidden />
          批量导入
        </Button>
        {/* 备份是管理员操作：一次导出等于把全部邮箱的访问权装进一个文件 */}
        {user?.isAdmin ? (
          <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
            <KeyRoundIcon aria-hidden />
            导出凭据
          </Button>
        ) : null}
      </header>

      {accountsQuery.isError ? (
        <ErrorBanner
          title="账号列表可能不是最新的"
          error={accountsQuery.error}
          onRetry={() => void accountsQuery.refetch()}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3 p-4">
          <HealthStats
            counts={counts}
            active={filters.status}
            onSelect={(status) => setFilters({ status })}
            loading={loading}
          />

          <AccountsToolbar
            filters={filters}
            onFilterChange={setFilters}
            onSyncAll={() => actions.syncNow(syncableAccounts(accounts))}
            syncing={actions.isSyncing || syncingAccountIds.size > 0}
            syncingCount={syncingAccountIds.size}
            searchRef={searchRef}
          />

          <p className="text-xs text-muted-foreground" aria-live="polite">
            {loading ? '正在加载账号…' : `共 ${accounts.length} 个账号，当前显示 ${visible.length} 个`}
          </p>

          {loading ? (
            <div aria-busy="true" className="rounded-lg border p-4">
              <TableSkeleton rows={6} columns={5} />
            </div>
          ) : visible.length === 0 ? (
            <EmptyView
              filtered={filtered}
              statusFilterLabel={
                filters.status === 'all' ? null : ACCOUNT_STATUS_META[filters.status].label
              }
              onReset={resetFilters}
              onCreate={() => void navigate('/accounts/new')}
              onImport={() => void navigate('/accounts/import')}
            />
          ) : (
            <AccountsTable
              accounts={visible}
              selectedIds={selectedIds}
              syncingAccountIds={syncingAccountIds}
              sort={sort}
              onSort={toggleSortKey}
              onToggleAll={toggleAll}
              onRowRef={(id, element) => {
                if (element) rowRefs.current.set(id, element);
                else rowRefs.current.delete(id);
              }}
              onToggleSelect={toggleSelect}
              onOpen={openDetail}
              onRepair={repair}
              onToggleSyncEnabled={actions.toggleSyncEnabled}
              onSyncNow={(account) => actions.syncNow([account])}
              onTest={(account) => void editor.test(account.id).catch(() => undefined)}
              onSetEnabled={(account, enabled) => actions.setEnabled([account], enabled)}
              onDelete={(account) => setPendingDelete([account])}
              onFocusRow={(account) => setFocusedId(account.id)}
            />
          )}
        </div>
      </div>

      <BulkActionBar
        count={selected.length}
        busy={actions.isUpdatingStatus || actions.isRemoving}
        onEnable={() => actions.setEnabled(selected, true)}
        onDisable={() => actions.setEnabled(selected, false)}
        onSync={() => actions.syncNow(selected)}
        onDelete={() => setPendingDelete(selected)}
        onClear={clearSelection}
      />

      <ConfirmDialog
        open={pendingDelete.length > 0}
        onOpenChange={(open) => {
          if (!open) setPendingDelete([]);
        }}
        title={
          pendingDelete.length === 1
            ? `删除 ${pendingDelete[0]?.email ?? ''}？`
            : `删除选中的 ${pendingDelete.length} 个账号？`
        }
        description="将同时删除这些账号在本地缓存的邮件。此操作不可撤销，邮件服务器上的邮件不受影响。"
        confirmLabel="删除"
        {...(pendingDelete.length > 1 ? { confirmWord: '删除' } : {})}
        onConfirm={async () => {
          const targets = pendingDelete;
          setPendingDelete([]);
          await actions.remove(targets);
          setSelectedIds((current) => {
            const next = new Set(current);
            for (const account of targets) next.delete(account.id);
            return next;
          });
        }}
      />

      <ExportCredentialsDialog open={exportOpen} onOpenChange={setExportOpen} accounts={accounts} />

      <Outlet
        context={
          {
            accounts,
            reload: () => void accountsQuery.refetch(),
          } satisfies AccountsOutletContext
        }
      />
    </div>
  );
}

function EmptyView({
  filtered,
  statusFilterLabel,
  onReset,
  onCreate,
  onImport,
}: {
  filtered: boolean;
  statusFilterLabel: string | null;
  onReset: () => void;
  onCreate: () => void;
  onImport: () => void;
}) {
  if (!filtered) {
    return (
      <EmptyState
        icon={UsersIcon}
        title="还没有添加账号"
        description="逐个添加，或用旧格式一次粘贴多个账号导入。"
        actions={
          <>
            <Button onClick={onCreate}>添加账号</Button>
            <Button variant="ghost" onClick={onImport}>
              批量导入
            </Button>
          </>
        }
      />
    );
  }

  // 「没有需重新授权的账号」是好消息，用对勾而不是灰盒子（screens.md §10.2）
  const isGoodNews = statusFilterLabel === '需重新授权' || statusFilterLabel === '同步失败';

  return (
    <EmptyState
      icon={isGoodNews ? CheckCircle2Icon : SearchXIcon}
      tone={isGoodNews ? 'success' : 'muted'}
      title={statusFilterLabel ? `没有「${statusFilterLabel}」状态的账号` : '没有符合条件的账号'}
      description={isGoodNews ? '所有账号都在正常工作。' : '试试换个关键词或清除筛选。'}
      actions={
        <Button variant="ghost" onClick={onReset}>
          查看全部
        </Button>
      }
    />
  );
}
