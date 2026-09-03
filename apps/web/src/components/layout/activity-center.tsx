import {
  ActivityIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  LoaderCircleIcon,
  WifiOffIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useActivity } from '@/hooks/use-activity';
import { KIND_LABEL, type ActivityEntry } from '@/lib/activity';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * 活动中心（interactions.md §6 的 toast 之外的那一半）。
 *
 * toast 会自己消失，而同步 / 连接测试 / 重新授权都是**几十秒级**的异步操作 ——
 * 用户离开一下再回来，就再也看不到结果了。这里保留最近的操作与它们的结局，
 * 并且：**不抢焦点**（只在用户点开时才打开、从不自动弹）、
 * **断线时明说状态未知**而不是继续假装在转圈。
 */
export function ActivityCenter() {
  const { entries, pending, connected } = useActivity();
  const [open, setOpen] = useState(false);

  const label =
    pending > 0 ? `活动中心，${pending} 个操作进行中` : '活动中心';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              className="relative"
            >
              {pending > 0 ? (
                <LoaderCircleIcon className="animate-spin" aria-hidden />
              ) : (
                <ActivityIcon aria-hidden />
              )}
              {pending > 0 ? (
                <span
                  aria-hidden
                  className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
                />
              ) : null}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-88 p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <h2 className="flex-1 text-sm font-medium">活动</h2>
          {pending > 0 ? (
            <span className="tnum text-2xs text-muted-foreground">{pending} 个进行中</span>
          ) : null}
        </div>

        {connected ? null : (
          <p
            role="status"
            className="flex items-center gap-2 bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-foreground"
          >
            <WifiOffIcon className="size-3.5 shrink-0" aria-hidden />
            实时连接已断开，下面的状态可能不是最新的；已改为定时拉取。
          </p>
        )}

        {entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            还没有进行中或最近完成的操作。
          </p>
        ) : (
          <ul className="max-h-80 overflow-y-auto py-1">
            {entries.map((entry) => (
              <li key={entry.id}>
                <ActivityRow entry={entry} onNavigate={() => setOpen(false)} />
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

const STATUS_META = {
  running: { icon: LoaderCircleIcon, tone: 'text-muted-foreground', spin: true, text: '进行中' },
  success: { icon: CheckCircle2Icon, tone: 'text-success', spin: false, text: '已完成' },
  error: { icon: CircleAlertIcon, tone: 'text-destructive', spin: false, text: '失败' },
  stale: { icon: WifiOffIcon, tone: 'text-warning', spin: false, text: '状态未知' },
} as const;

function ActivityRow({ entry, onNavigate }: { entry: ActivityEntry; onNavigate: () => void }) {
  const navigate = useNavigate();
  const meta = STATUS_META[entry.status];
  const Icon = meta.icon;
  const at = entry.endedAt ?? entry.startedAt;

  return (
    <button
      type="button"
      onClick={() => {
        onNavigate();
        void navigate(`/accounts/${entry.accountId}`);
      }}
      className="focus-ring-inset flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/50"
    >
      <Icon
        className={cn('mt-0.5 size-3.5 shrink-0', meta.tone, meta.spin && 'animate-spin')}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 truncate text-sm">{KIND_LABEL[entry.kind]}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {entry.accountEmail || `账号 #${entry.accountId}`}
          </span>
          <time
            dateTime={new Date(at).toISOString()}
            className="tnum shrink-0 text-2xs text-muted-foreground"
          >
            {formatRelativeTime(at)}
          </time>
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {meta.text}
          {entry.detail ? ` · ${entry.detail}` : ''}
        </span>
      </span>
    </button>
  );
}
