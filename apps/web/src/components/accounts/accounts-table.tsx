import type { Account } from '@firemail/shared';
import { ChevronDownIcon, ChevronUpIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { AccountRow, type AccountRowProps } from '@/components/accounts/account-row';
import { Checkbox } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import { errorCode, type AccountSort, type AccountSortKey } from '@/lib/accounts/dashboard';
import { readJson, writeJson } from '@/lib/storage';
import { cn } from '@/lib/utils';

/** 折叠起来的错误说明行按账号记住（screens.md §3）。 */
const COLLAPSED_ERRORS_KEY = 'fm.accountErrorsCollapsed';

interface Column {
  key: AccountSortKey | null;
  label: string;
  className?: string;
}

const COLUMNS: Column[] = [
  { key: 'email', label: '账号' },
  { key: 'provider', label: '服务商', className: 'hidden md:table-cell' },
  { key: 'status', label: '状态' },
  { key: 'lastSynced', label: '上次同步', className: 'hidden lg:table-cell' },
  { key: 'unread', label: '未读', className: 'hidden text-right md:table-cell' },
  { key: null, label: '同步' },
  { key: null, label: '操作', className: 'text-right' },
];

export type AccountsTableProps = {
  accounts: Account[];
  selectedIds: ReadonlySet<number>;
  syncingAccountIds: ReadonlySet<number>;
  sort: AccountSort;
  onSort: (key: AccountSortKey) => void;
  onToggleAll: () => void;
  onRowRef: (id: number, element: HTMLButtonElement | null) => void;
} & Pick<
  AccountRowProps,
  | 'onToggleSelect'
  | 'onOpen'
  | 'onRepair'
  | 'onToggleSyncEnabled'
  | 'onSyncNow'
  | 'onTest'
  | 'onSetEnabled'
  | 'onDelete'
  | 'onFocusRow'
>;

export function AccountsTable({
  accounts,
  selectedIds,
  syncingAccountIds,
  sort,
  onSort,
  onToggleAll,
  onRowRef,
  ...rowHandlers
}: AccountsTableProps) {
  const [collapsed, setCollapsed] = useState<number[]>(() =>
    readJson<number[]>(COLLAPSED_ERRORS_KEY, []),
  );

  const toggleError = (id: number) => {
    setCollapsed((current) => {
      const next = current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
      writeJson(COLLAPSED_ERRORS_KEY, next);
      return next;
    });
  };

  const allSelected = accounts.length > 0 && accounts.every((a) => selectedIds.has(a.id));
  const someSelected = accounts.some((a) => selectedIds.has(a.id));

  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <caption className="sr-only">
        账号列表，共 {accounts.length} 个账号。使用 J / K 在账号之间移动，X 勾选当前账号。
      </caption>
      <thead className="sticky top-0 z-sticky bg-background/95 backdrop-blur">
        <tr className="border-b text-2xs text-muted-foreground">
          <th scope="col" className="w-9 border-b px-2 py-1.5">
            <Checkbox
              checked={allSelected}
              indeterminate={!allSelected && someSelected}
              onCheckedChange={onToggleAll}
              label={allSelected ? '取消全选' : '全选当前列表的账号'}
            />
          </th>
          {COLUMNS.map(({ key, label, className }) => (
            <th
              key={label}
              scope="col"
              className={cn('border-b px-2 py-1.5 text-left font-medium', className)}
              aria-sort={
                key && sort.key === key
                  ? sort.direction === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : undefined
              }
            >
              {key ? (
                <button
                  type="button"
                  onClick={() => onSort(key)}
                  className="focus-ring inline-flex items-center gap-1 rounded-xs hover:text-foreground"
                >
                  {label}
                  {sort.key === key ? (
                    sort.direction === 'asc' ? (
                      <ChevronUpIcon className="size-3" aria-hidden />
                    ) : (
                      <ChevronDownIcon className="size-3" aria-hidden />
                    )
                  ) : null}
                </button>
              ) : (
                label
              )}
            </th>
          ))}
        </tr>
      </thead>

      <tbody>
        {accounts.map((account) => {
          const showError = account.lastError !== null && !collapsed.includes(account.id);
          return [
            <AccountRow
              key={account.id}
              ref={(element) => onRowRef(account.id, element)}
              account={account}
              selected={selectedIds.has(account.id)}
              syncing={syncingAccountIds.has(account.id)}
              {...rowHandlers}
            />,
            account.lastError ? (
              <tr key={`${account.id}-error`}>
                <td colSpan={COLUMNS.length + 1} className="border-b px-2 pb-1.5">
                  {showError ? (
                    <div
                      className={cn(
                        'flex items-start gap-2 rounded-sm px-2 py-1',
                        account.status === 'error'
                          ? 'bg-destructive-subtle text-destructive-subtle-foreground'
                          : 'bg-warning-subtle text-warning-subtle-foreground',
                      )}
                    >
                      <code className="min-w-0 flex-1 font-mono text-2xs break-all">
                        {account.lastError}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`收起 ${account.email} 的错误详情`}
                        onClick={() => toggleError(account.id)}
                      >
                        <XIcon aria-hidden />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground"
                      onClick={() => toggleError(account.id)}
                    >
                      查看错误详情
                      {errorCode(account) ? (
                        <code className="font-mono text-2xs">{errorCode(account)}</code>
                      ) : null}
                    </Button>
                  )}
                </td>
              </tr>
            ) : null,
          ];
        })}
      </tbody>
    </table>
  );
}
