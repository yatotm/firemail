import {
  ArrowDownWideNarrowIcon,
  HashIcon,
  MailIcon,
  PaperclipIcon,
  RefreshCwIcon,
  Rows3Icon,
  SearchIcon,
  StarIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import type { KeyboardEvent, RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DENSITY_LABEL, DENSITIES, type Density } from '@/hooks/use-density';
import { formatCount } from '@/lib/format';
import type { MailFilters } from '@/lib/mail/query';
import { viewLabel, type MailView } from '@/lib/nav';
import { cn } from '@/lib/utils';

export interface ListToolbarProps {
  view: MailView;
  viewName: string;
  count: number | undefined;
  filters: MailFilters;
  onFiltersChange: (filters: MailFilters) => void;
  /** 「验证码」是一个视图而不是过滤条件（服务端要做关键词过滤 + 7 天窗口）。 */
  onToggleCodes: () => void;
  density: Density;
  onDensityChange: (density: Density) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  onSubmitSearch: (query: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}

/**
 * 列表工具条。应用顶栏已经有作用域切换和全局搜索，这里只放**与这一列表相关**的东西：
 * 视图名与计数、过滤 chip、密度、排序、刷新。
 */
export function ListToolbar({
  view,
  viewName,
  count,
  filters,
  onFiltersChange,
  onToggleCodes,
  density,
  onDensityChange,
  searchRef,
  onSubmitSearch,
  onRefresh,
  refreshing,
}: ListToolbarProps) {
  const submit = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    onSubmitSearch(event.currentTarget.value);
  };

  return (
    <div className="fm-no-print shrink-0 border-b bg-background">
      <div className="flex h-10 items-center gap-2 px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{viewName}</h2>
        {count === undefined ? null : (
          <span className="tnum shrink-0 text-2xs text-muted-foreground">{formatCount(count)}</span>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="列表密度与排序">
              <Rows3Icon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>列表密度</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={density}
              onValueChange={(value) => onDensityChange(value as Density)}
            >
              {DENSITIES.map((item) => (
                <DropdownMenuRadioItem key={item} value={item}>
                  {DENSITY_LABEL[item]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>排序</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={filters.order === 'asc' ? 'asc' : 'desc'}
              onValueChange={(value) =>
                onFiltersChange({ ...filters, ...(value === 'asc' ? { order: 'asc' } : { order: undefined }) })
              }
            >
              <DropdownMenuRadioItem value="desc">
                <ArrowDownWideNarrowIcon aria-hidden />
                最新在前
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="asc">最旧在前</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={onRefresh} aria-label="刷新列表">
              <RefreshCwIcon className={refreshing ? 'animate-spin' : undefined} aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>刷新列表</TooltipContent>
        </Tooltip>
      </div>

      <div className="px-3 pb-2">
        <div className="focus-ring-within flex h-9 items-center gap-2 rounded-sm border border-input px-2">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            variant="bare"
            ref={searchRef}
            type="search"
            placeholder={`在${viewLabel(view)}中搜索`}
            aria-label="搜索邮件"
            onKeyDown={submit}
            className="flex-1 text-sm"
          />
          <Kbd keys="/" className="hidden shrink-0 sm:inline-flex" />
        </div>
      </div>

      <div className="flex h-8 items-center gap-1.5 overflow-x-auto px-3 pb-2">
        <FilterChip
          icon={MailIcon}
          label="未读"
          active={filters.unread === true}
          onClick={() =>
            onFiltersChange({ ...filters, unread: filters.unread === true ? undefined : true })
          }
        />
        <FilterChip
          icon={StarIcon}
          label="星标"
          active={filters.starred === true}
          onClick={() =>
            onFiltersChange({ ...filters, starred: filters.starred === true ? undefined : true })
          }
        />
        <FilterChip
          icon={PaperclipIcon}
          label="附件"
          active={filters.hasAttachments === true}
          onClick={() =>
            onFiltersChange({
              ...filters,
              hasAttachments: filters.hasAttachments === true ? undefined : true,
            })
          }
        />
        <FilterChip
          icon={HashIcon}
          label="验证码"
          active={view === 'codes'}
          onClick={onToggleCodes}
        />

        {filters.from ? (
          <FilterChip
            icon={XIcon}
            label={`发件人：${filters.from}`}
            active
            onClick={() => onFiltersChange({ ...filters, from: undefined })}
          />
        ) : null}
      </div>
    </div>
  );
}

function FilterChip({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-2xs transition-colors',
        active
          ? 'border-transparent bg-accent text-accent-foreground'
          : 'border-input text-muted-foreground hover:bg-accent/40',
      )}
    >
      <Icon className="size-3" aria-hidden />
      {label}
    </button>
  );
}
