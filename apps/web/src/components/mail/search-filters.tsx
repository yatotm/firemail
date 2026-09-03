import type { Account, Folder } from '@firemail/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DEFAULT_SEARCH_FILTERS,
  formatDateInput,
  parseDate,
  type SearchFilters,
} from '@/lib/mail/search-query';
import { cn } from '@/lib/utils';

const DAY = 24 * 60 * 60 * 1000;

export interface SearchFiltersPanelProps {
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
  accounts: readonly Account[];
  folders: readonly Folder[];
}

/**
 * 搜索筛选侧栏（screens.md §6）。
 *
 * 账号是**单选**而不是多选：`searchQuerySchema` 只有 `accountId`，
 * 画成多选框却只能生效一个是在骗用户。
 */
export function SearchFiltersPanel({
  filters,
  onChange,
  accounts,
  folders,
}: SearchFiltersPanelProps) {
  const [showAllAccounts, setShowAllAccounts] = useState(false);
  const visibleAccounts = showAllAccounts ? accounts : accounts.slice(0, 5);

  const set = (patch: Partial<SearchFilters>) => onChange({ ...filters, ...patch });

  const specialFolders = folders.filter((folder) => folder.specialUse !== null);
  const byUse = new Map<string, Folder[]>();
  for (const folder of specialFolders) {
    const list = byUse.get(folder.specialUse ?? '') ?? [];
    list.push(folder);
    byUse.set(folder.specialUse ?? '', list);
  }

  return (
    <aside
      aria-label="搜索筛选"
      className="hidden w-56 shrink-0 space-y-4 overflow-y-auto border-r p-3 lg:block"
    >
      <Group title="账号">
        <Choice
          checked={filters.accountId === undefined}
          onSelect={() => set({ accountId: undefined })}
          label="全部账号"
        />
        {visibleAccounts.map((account) => (
          <Choice
            key={account.id}
            checked={filters.accountId === account.id}
            onSelect={() => set({ accountId: account.id })}
            label={account.email}
          />
        ))}
        {accounts.length > 5 ? (
          <button
            type="button"
            onClick={() => setShowAllAccounts((value) => !value)}
            className="px-1 text-2xs text-primary hover:underline"
          >
            {showAllAccounts ? '收起' : `更多 (${accounts.length - 5})`}
          </button>
        ) : null}
      </Group>

      <Group title="文件夹">
        <Choice
          checked={filters.folderId === undefined}
          onSelect={() => set({ folderId: undefined })}
          label="全部文件夹"
        />
        {folders
          .filter((folder) => filters.accountId === undefined || folder.accountId === filters.accountId)
          .filter((folder) => folder.specialUse !== null)
          .slice(0, 12)
          .map((folder) => (
            <Choice
              key={folder.id}
              checked={filters.folderId === folder.id}
              onSelect={() => set({ folderId: folder.id })}
              label={folder.name}
            />
          ))}
        {filters.accountId === undefined ? (
          <p className="px-1 text-2xs text-muted-foreground">先选一个账号才能按文件夹筛选</p>
        ) : null}
      </Group>

      <Group title="时间">
        <Choice
          checked={filters.since === undefined && filters.until === undefined}
          onSelect={() => set({ since: undefined, until: undefined })}
          label="全部"
        />
        <Choice
          checked={filters.since === startOfDaysAgo(7)}
          onSelect={() => set({ since: startOfDaysAgo(7), until: undefined })}
          label="近 7 天"
        />
        <Choice
          checked={filters.since === startOfDaysAgo(30)}
          onSelect={() => set({ since: startOfDaysAgo(30), until: undefined })}
          label="近 30 天"
        />
        <div className="mt-1 space-y-1 px-1">
          <Label htmlFor="search-since" className="text-2xs text-muted-foreground">
            自定义起止
          </Label>
          <Input
            id="search-since"
            type="date"
            value={formatDateInput(filters.since)}
            onChange={(event) => set({ since: parseDate(event.target.value) ?? undefined })}
            className="h-7 text-2xs"
          />
          <Input
            id="search-until"
            type="date"
            aria-label="截止日期"
            value={formatDateInput(filters.until)}
            onChange={(event) => {
              const date = parseDate(event.target.value);
              set({ until: date === null ? undefined : date + DAY - 1 });
            }}
            className="h-7 text-2xs"
          />
        </div>
      </Group>

      <Group title="属性">
        <Toggle
          checked={filters.unread === true}
          onToggle={() => set({ unread: filters.unread === true ? undefined : true })}
          label="未读"
        />
        <Toggle
          checked={filters.starred === true}
          onToggle={() => set({ starred: filters.starred === true ? undefined : true })}
          label="星标"
        />
        <Toggle
          checked={filters.hasAttachments === true}
          onToggle={() =>
            set({ hasAttachments: filters.hasAttachments === true ? undefined : true })
          }
          label="有附件"
        />
        <Toggle
          checked={filters.hasCode === true}
          onToggle={() => set({ hasCode: filters.hasCode === true ? undefined : true })}
          label="有验证码"
          hint="在已加载的结果里筛选（服务端没有验证码检索）"
        />
      </Group>

      <Button
        variant="ghost"
        size="sm"
        className="w-full"
        onClick={() => onChange({ ...DEFAULT_SEARCH_FILTERS, sort: filters.sort })}
      >
        重置筛选
      </Button>
    </aside>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="px-1 pb-1 text-2xs font-medium text-muted-foreground">{title}</h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function Choice({
  checked,
  onSelect,
  label,
}: {
  checked: boolean;
  onSelect: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      title={label}
      className={cn(
        'flex h-7 items-center gap-2 rounded-sm px-1 text-left text-xs transition-colors hover:bg-accent/40',
        checked ? 'font-medium text-foreground' : 'text-muted-foreground',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-2.5 shrink-0 rounded-full border',
          checked ? 'border-primary bg-primary' : 'border-input',
        )}
      />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function Toggle({
  checked,
  onToggle,
  label,
  hint,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      title={hint ?? label}
      className={cn(
        'flex h-7 items-center gap-2 rounded-sm px-1 text-left text-xs transition-colors hover:bg-accent/40',
        checked ? 'font-medium text-foreground' : 'text-muted-foreground',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-2.5 shrink-0 rounded-xs border',
          checked ? 'border-primary bg-primary' : 'border-input',
        )}
      />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function startOfDaysAgo(days: number): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime() - days * DAY;
}
