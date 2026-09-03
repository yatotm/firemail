import type { Account } from '@firemail/shared';
import { EllipsisIcon } from 'lucide-react';
import { forwardRef } from 'react';
import { AccountBar } from '@/components/common/account-avatar';
import { AccountStatusLabel } from '@/components/common/account-status';
import { Checkbox, Switch } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PROVIDER_LABEL, REPAIR_ACTION_LABEL, repairAction } from '@/lib/accounts/dashboard';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface AccountRowProps {
  account: Account;
  selected: boolean;
  syncing: boolean;
  onToggleSelect: (account: Account) => void;
  onOpen: (account: Account) => void;
  onRepair: (account: Account) => void;
  onToggleSyncEnabled: (account: Account) => void;
  onSyncNow: (account: Account) => void;
  onTest: (account: Account) => void;
  onSetEnabled: (account: Account, enabled: boolean) => void;
  onDelete: (account: Account) => void;
  onFocusRow: (account: Account) => void;
}

/**
 * 一行一个账号。修复动作（重新授权 / 测试连接 / 启用）就在这一行里，
 * 不要求用户先点进详情 —— 发现问题和解决问题必须在同一个位置（screens.md §3）。
 */
export const AccountRow = forwardRef<HTMLButtonElement, AccountRowProps>(function AccountRow(
  {
    account,
    selected,
    syncing,
    onToggleSelect,
    onOpen,
    onRepair,
    onToggleSyncEnabled,
    onSyncNow,
    onTest,
    onSetEnabled,
    onDelete,
    onFocusRow,
  },
  ref,
) {
  const repair = repairAction(account);

  return (
    <tr
      className={cn(
        'border-b transition-colors hover:bg-row-hover',
        selected && 'bg-row-checked',
        account.syncEnabled ? '' : 'text-muted-foreground',
      )}
    >
      <td className="w-9 px-2">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(account)}
          label={`选择 ${account.email}`}
        />
      </td>

      <td className="min-w-0 py-1.5 pr-2">
        <div className="flex items-center gap-2">
          <AccountBar email={account.email} className="h-8 self-stretch" />
          <button
            ref={ref}
            type="button"
            onClick={() => onOpen(account)}
            onFocus={() => onFocusRow(account)}
            className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="block truncate text-sm" title={account.email}>
              {account.email}
            </span>
            {account.displayName ? (
              <span className="block truncate text-2xs text-muted-foreground">
                {account.displayName}
              </span>
            ) : null}
          </button>
          {syncing ? (
            <span
              className="size-3 shrink-0 animate-spin rounded-full border border-muted-foreground border-t-transparent"
              role="status"
              aria-label={`${account.email} 正在同步`}
            />
          ) : null}
        </div>
      </td>

      <td className="hidden px-2 text-xs text-muted-foreground md:table-cell">
        {PROVIDER_LABEL[account.provider]}
      </td>

      <td className="px-2">
        <AccountStatusLabel status={account.status} />
      </td>

      <td className="hidden px-2 text-xs text-muted-foreground lg:table-cell">
        <time dateTime={toIsoString(account.lastSyncedAt)} title={formatAbsoluteTime(account.lastSyncedAt)}>
          {formatRelativeTime(account.lastSyncedAt)}
        </time>
      </td>

      <td className="hidden px-2 text-right text-xs md:table-cell">
        <span className="tnum">{account.unreadCount || '–'}</span>
      </td>

      <td className="px-2">
        <Switch
          checked={account.syncEnabled}
          onCheckedChange={() => onToggleSyncEnabled(account)}
          label={account.syncEnabled ? `暂停同步 ${account.email}` : `开启同步 ${account.email}`}
        />
      </td>

      <td className="px-2 py-1.5 text-right">
        <div className="flex items-center justify-end gap-1">
          {repair ? (
            <Button size="sm" onClick={() => onRepair(account)}>
              {REPAIR_ACTION_LABEL[repair]}
            </Button>
          ) : null}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`${account.email} 的更多操作`}>
                <EllipsisIcon aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onOpen(account)}>账号详情</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onSyncNow(account)}>立即同步</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onTest(account)}>测试连接</DropdownMenuItem>
              {account.authType === 'oauth2' ? (
                <DropdownMenuItem onSelect={() => onRepair(account)}>重新授权</DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => onSetEnabled(account, account.status === 'disabled')}
              >
                {account.status === 'disabled' ? '启用账号' : '停用账号'}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => onDelete(account)}>
                删除账号
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  );
});
