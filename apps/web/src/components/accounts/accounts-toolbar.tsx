import { accountProviderSchema, accountStatusSchema } from '@firemail/shared';
import { RefreshCwIcon, SearchIcon } from 'lucide-react';
import type { RefObject } from 'react';
import { SelectField } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ACCOUNT_STATUS_META } from '@/lib/account-status';
import { PROVIDER_LABEL, type AccountFilters } from '@/lib/accounts/dashboard';
import type { SyncProgress } from '@/hooks/accounts/use-account-actions';

const STATUS_OPTIONS = [
  { value: 'all' as const, label: '全部状态' },
  ...accountStatusSchema.options.map((status) => ({
    value: status,
    label: ACCOUNT_STATUS_META[status].label,
  })),
];

const PROVIDER_OPTIONS = [
  { value: 'all' as const, label: '全部服务商' },
  ...accountProviderSchema.options.map((provider) => ({
    value: provider,
    label: PROVIDER_LABEL[provider],
  })),
];

export function AccountsToolbar({
  filters,
  onFilterChange,
  onSyncAll,
  syncing,
  syncProgress,
  searchRef,
}: {
  filters: AccountFilters;
  onFilterChange: (patch: Partial<AccountFilters>) => void;
  onSyncAll: () => void;
  syncing: boolean;
  syncProgress: SyncProgress | null;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="relative min-w-56 flex-1">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={searchRef}
          type="search"
          value={filters.q}
          placeholder="搜索邮箱或显示名"
          aria-label="搜索账号"
          className="h-8 pl-8"
          onChange={(event) => onFilterChange({ q: event.target.value })}
        />
      </div>

      <SelectField
        id="account-status-filter"
        label="按状态筛选"
        srOnlyLabel
        value={filters.status}
        options={STATUS_OPTIONS}
        onChange={(status) => onFilterChange({ status })}
        className="w-36"
      />

      <SelectField
        id="account-provider-filter"
        label="按服务商筛选"
        srOnlyLabel
        value={filters.provider}
        options={PROVIDER_OPTIONS}
        onChange={(provider) => onFilterChange({ provider })}
        className="w-36"
      />

      <Button variant="outline" size="sm" onClick={onSyncAll} disabled={syncing}>
        <RefreshCwIcon className={syncing ? 'animate-spin' : undefined} aria-hidden />
        {syncProgress ? `同步中 ${syncProgress.done}/${syncProgress.total}` : '全部同步'}
      </Button>
    </div>
  );
}
