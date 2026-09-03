import type { Account } from '@firemail/shared';
import { ChevronsUpDownIcon, InboxIcon, SettingsIcon } from 'lucide-react';
import { useNavigate } from 'react-router';
import { AccountAvatar } from '@/components/common/account-avatar';
import { StatusDot } from '@/components/common/account-status';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Kbd } from '@/components/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { sortAccountsByHealth } from '@/hooks/use-accounts';
import { ACCOUNT_STATUS_META } from '@/lib/account-status';
import { formatCount } from '@/lib/format';
import { ALL_SCOPE, type MailScope } from '@/lib/nav';
import { cn } from '@/lib/utils';

const PROVIDER_LABEL: Record<Account['provider'], string> = {
  outlook: 'Outlook',
  gmail: 'Gmail',
  qq: 'QQ',
  imap: 'IMAP',
};

export interface ScopeSwitcherProps {
  accounts: Account[];
  scope: MailScope;
  onScopeChange: (scope: MailScope) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  totalUnread?: number | undefined;
  className?: string;
}

/**
 * 账号切换器 —— 这个 IA 的枢纽组件（IA §9）。
 * 选中后**只改 scope，不改 view**；坏账号排最前；provider 用文字标签不用彩色 logo。
 */
export function ScopeSwitcher({
  accounts,
  scope,
  onScopeChange,
  open,
  onOpenChange,
  totalUnread,
  className,
}: ScopeSwitcherProps) {
  const navigate = useNavigate();
  const sorted = sortAccountsByHealth(accounts);
  const broken = sorted.filter((a) => a.status === 'auth_error' || a.status === 'error');
  const healthy = sorted.filter((a) => a.status !== 'auth_error' && a.status !== 'error');
  const current = scope.kind === 'account' ? accounts.find((a) => a.id === scope.accountId) : null;

  const select = (next: MailScope) => {
    onScopeChange(next);
    onOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={`当前作用域：${current ? current.email : '全部账号'}，切换账号`}
          className={cn('h-8 max-w-64 gap-1.5 px-2 font-normal', className)}
        >
          {current ? (
            <AccountAvatar email={current.email} displayName={current.displayName} size={18} />
          ) : (
            <InboxIcon className="size-4 text-muted-foreground" aria-hidden />
          )}
          <span className="min-w-0 truncate text-sm">{current ? current.email : '全部账号'}</span>
          <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-[360px] p-0">
        <Command loop>
          <CommandInput placeholder="搜索账号…" />
          <CommandList>
            <CommandEmpty>没有匹配的账号</CommandEmpty>

            <CommandGroup>
              <CommandItem value="all 全部账号" onSelect={() => select(ALL_SCOPE)}>
                <InboxIcon aria-hidden />
                <span className="flex-1">全部账号</span>
                {totalUnread ? (
                  <span className="tnum text-2xs text-muted-foreground">
                    {formatCount(totalUnread)} 未读
                  </span>
                ) : null}
              </CommandItem>
            </CommandGroup>

            {broken.length > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup heading="需要处理">
                  {broken.map((account) => (
                    <AccountRow key={account.id} account={account} onSelect={select} />
                  ))}
                </CommandGroup>
              </>
            ) : null}

            <CommandSeparator />
            <CommandGroup heading={`全部 (${healthy.length})`}>
              {healthy.map((account) => (
                <AccountRow key={account.id} account={account} onSelect={select} />
              ))}
            </CommandGroup>

            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="管理账号 accounts"
                onSelect={() => {
                  onOpenChange(false);
                  void navigate('/accounts');
                }}
              >
                <SettingsIcon aria-hidden />
                <span className="flex-1">管理账号</span>
                <Kbd keys="g m" />
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AccountRow({
  account,
  onSelect,
}: {
  account: Account;
  onSelect: (scope: MailScope) => void;
}) {
  const meta = ACCOUNT_STATUS_META[account.status];
  const broken = account.status === 'auth_error' || account.status === 'error';

  return (
    <CommandItem
      value={`${account.email} ${account.displayName ?? ''} ${PROVIDER_LABEL[account.provider]}`}
      onSelect={() => onSelect({ kind: 'account', accountId: account.id })}
    >
      <StatusDot status={account.status} />
      <span className="min-w-0 flex-1 truncate" title={account.email}>
        {account.email}
      </span>
      {broken || account.status === 'disabled' ? (
        <span className={cn('text-2xs', meta.className)}>{meta.label}</span>
      ) : account.unreadCount > 0 ? (
        <span className="tnum text-2xs text-muted-foreground">
          {formatCount(account.unreadCount)}
        </span>
      ) : null}
      <span className="w-14 shrink-0 text-right text-2xs text-muted-foreground">
        {PROVIDER_LABEL[account.provider]}
      </span>
    </CommandItem>
  );
}
