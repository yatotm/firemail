import { logLevelSchema, MAX_LOG_MAX_MB, MIN_LOG_MAX_MB, type LogEntry } from '@firemail/shared';
import { RefreshCwIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ListSkeleton } from '@/components/common/skeletons';
import { SettingBlock, SettingRow, Switch, TextField } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectOption } from '@/components/ui/select';
import { useLogConfig, useLogFeed, useLogStatus } from '@/hooks/use-logs';
import {
  EMPTY_FILTERS,
  LEVEL_LABEL,
  LEVEL_TONE,
  formatBytes,
  type LogFilters,
} from '@/lib/logs';
import { cn } from '@/lib/utils';

const LEVELS = logLevelSchema.options;

/**
 * 设置 → 日志。
 *
 * 它是第一级后台同步的**唯一**出口：那一层的流水不进活动中心（进了角标就永远
 * 亮着「进行中」，见 lib/activity.ts），但「账号什么时候同步的、为什么失败、
 * 被限流了几次」这些问题仍然要有地方回答。
 */
export function LogsPanel() {
  const [filters, setFilters] = useState<LogFilters>(EMPTY_FILTERS);
  const [live, setLive] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const feed = useLogFeed(filters, live);
  const status = useLogStatus();
  const config = useLogConfig(() => feed.reload());

  const patch = (next: Partial<LogFilters>) => setFilters((current) => ({ ...current, ...next }));

  return (
    <div className="divide-y">
      <section className="space-y-3 py-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1 space-y-1">
            <Label htmlFor="log-search" className="text-xs text-muted-foreground">
              搜索
            </Label>
            <div className="relative">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                id="log-search"
                className="pl-8"
                placeholder="按正文搜索，例如 outlook"
                value={filters.q}
                onChange={(event) => patch({ q: event.target.value })}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="log-level" className="text-xs text-muted-foreground">
              最低级别
            </Label>
            <Select
              id="log-level"
              className="w-28"
              value={filters.level}
              onChange={(event) => patch({ level: event.target.value as LogFilters['level'] })}
            >
              <SelectOption value="all">全部</SelectOption>
              {LEVELS.map((level) => (
                <SelectOption key={level} value={level}>
                  {LEVEL_LABEL[level]}
                </SelectOption>
              ))}
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="log-from" className="text-xs text-muted-foreground">
              起始日期
            </Label>
            <Input
              id="log-from"
              type="date"
              className="w-40"
              value={filters.from}
              onChange={(event) => patch({ from: event.target.value })}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="log-to" className="text-xs text-muted-foreground">
              结束日期
            </Label>
            <Input
              id="log-to"
              type="date"
              className="w-40"
              value={filters.to}
              onChange={(event) => patch({ to: event.target.value })}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Switch checked={live} onCheckedChange={setLive} label="实时刷新" />
          {/* 开关自己带 aria-label，这里的文字只给眼睛看，否则屏幕阅读器会读两遍 */}
          <span aria-hidden className="text-xs text-muted-foreground">
            实时刷新
          </span>

          <Button variant="ghost" size="sm" onClick={feed.reload} disabled={feed.isLoading}>
            <RefreshCwIcon className={cn(feed.isLoading && 'animate-spin')} aria-hidden />
            刷新
          </Button>

          {isFiltered(filters) ? (
            <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
              清除筛选
            </Button>
          ) : null}

          <span className="ml-auto text-2xs text-muted-foreground">
            {status.data
              ? `共 ${String(status.data.count)} 条 · 占用 ${formatBytes(status.data.bytes)} / ${String(status.data.config.maxMb)} MB`
              : null}
          </span>
        </div>

        <LogList feed={feed} />
      </section>

      <SettingBlock
        title="详细程度"
        description="「详细」会额外记录调试信息与每一条 HTTP 请求，量大得多，排查完建议调回「普通」。控制台输出不受这一项影响。"
      >
        <Select
          className="w-40"
          aria-label="日志详细程度"
          value={status.data?.config.level ?? 'info'}
          disabled={!status.data || config.isSaving}
          onChange={(event) =>
            config.save({ level: event.target.value === 'debug' ? 'debug' : 'info' })
          }
        >
          <SelectOption value="info">普通</SelectOption>
          <SelectOption value="debug">详细（含调试与请求日志）</SelectOption>
        </Select>
      </SettingBlock>

      <MaxSizeBlock
        current={status.data?.config.maxMb}
        disabled={!status.data || config.isSaving}
        onSave={(maxMb) => config.save({ maxMb })}
      />

      <SettingRow
        title="清空日志"
        description="删除已记录的全部日志。这条操作本身会留下一行记录。"
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={config.isClearing}
            onClick={() => setConfirmClear(true)}
          >
            <Trash2Icon aria-hidden />
            清空
          </Button>
        }
      />

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="清空全部日志？"
        description="已记录的日志会被永久删除，无法恢复。正在排查问题的话，先把需要的内容复制出来。"
        confirmLabel="清空"
        destructive
        onConfirm={() => {
          config.clear();
          setConfirmClear(false);
        }}
      />
    </div>
  );
}

function isFiltered(filters: LogFilters): boolean {
  return filters.level !== 'all' || filters.q !== '' || filters.from !== '' || filters.to !== '';
}

/** 容量上限要校验，所以它有显式的保存按钮，和同步间隔一个道理。 */
function MaxSizeBlock({
  current,
  disabled,
  onSave,
}: {
  current: number | undefined;
  disabled: boolean;
  onSave: (maxMb: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(current ?? '');
  const parsed = Number(value);
  const valid =
    Number.isInteger(parsed) && parsed >= MIN_LOG_MAX_MB && parsed <= MAX_LOG_MAX_MB;

  return (
    <SettingBlock
      title="容量上限"
      description={`超出后从最旧的开始循环清理。允许 ${String(MIN_LOG_MAX_MB)}–${String(MAX_LOG_MAX_MB)} MB。`}
    >
      <div className="flex items-end gap-2">
        <TextField
          id="log-max-mb"
          label="MB"
          type="number"
          className="w-32"
          value={value}
          error={valid || draft === null ? undefined : `请填 ${String(MIN_LOG_MAX_MB)}–${String(MAX_LOG_MAX_MB)} 之间的整数`}
          onChange={setDraft}
        />
        <Button
          size="sm"
          disabled={disabled || !valid || draft === null || parsed === current}
          onClick={() => {
            onSave(parsed);
            setDraft(null);
          }}
        >
          保存
        </Button>
      </div>
    </SettingBlock>
  );
}

function LogList({ feed }: { feed: ReturnType<typeof useLogFeed> }) {
  if (feed.isLoading) return <ListSkeleton rows={6} />;

  if (feed.error) {
    return (
      <p role="alert" className="rounded-md bg-destructive-subtle px-3 py-6 text-center text-sm">
        {feed.error}
      </p>
    );
  }

  if (feed.entries.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
        没有匹配的日志。
      </p>
    );
  }

  return (
    <div className="rounded-md border">
      <ul className="max-h-120 divide-y overflow-y-auto">
        {feed.entries.map((entry) => (
          <li key={entry.id}>
            <LogRow entry={entry} />
          </li>
        ))}
      </ul>
      {feed.hasMore ? (
        <div className="border-t p-2 text-center">
          <Button variant="ghost" size="sm" onClick={feed.loadMore} disabled={feed.isLoadingMore}>
            {feed.isLoadingMore ? '加载中…' : '加载更早的'}
          </Button>
        </div>
      ) : (
        <p className="border-t py-1.5 text-center text-2xs text-muted-foreground">已到底</p>
      )}
    </div>
  );
}

/** 时间用 tnum 对齐：一列数字左右横跳比字体不好看严重得多。 */
function LogRow({ entry }: { entry: LogEntry }) {
  const meta = entry.meta === null ? null : JSON.stringify(entry.meta);

  return (
    <div className="flex items-start gap-2 px-3 py-1.5 text-xs">
      <time
        dateTime={new Date(entry.at).toISOString()}
        className="tnum shrink-0 text-muted-foreground"
      >
        {formatLogTime(entry.at)}
      </time>
      <span className={cn('w-8 shrink-0 font-medium', LEVEL_TONE[entry.level])}>
        {LEVEL_LABEL[entry.level]}
      </span>
      <span className="min-w-0 flex-1 break-words">
        {entry.message}
        {meta ? <span className="ml-1.5 break-all text-muted-foreground">{meta}</span> : null}
      </span>
    </div>
  );
}

function formatLogTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
