import { useQuery } from '@tanstack/react-query';
import { CopyIcon } from 'lucide-react';
import { SettingBlock } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import * as accountsApi from '@/lib/accounts/api';
import { copyText } from '@/lib/accounts/copy';
import { showInfoToast } from '@/lib/undo';

/**
 * 关于。版本、运行时长与浏览器信息一键复制 —— 提 issue 的时候要用
 * （accessibility.md 反模式 #16）。
 */
export function AboutPanel() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => accountsApi.fetchHealth(signal),
    staleTime: 60_000,
    retry: false,
  });

  const rows: { label: string; value: string }[] = [
    { label: '服务端版本', value: health.data?.version ?? (health.isPending ? '读取中…' : '未知') },
    {
      label: '服务端运行时长',
      value:
        health.data?.uptimeSeconds === undefined
          ? '未知'
          : `${Math.floor(health.data.uptimeSeconds / 3600)} 小时 ${Math.floor((health.data.uptimeSeconds % 3600) / 60)} 分钟`,
    },
    { label: '前端构建模式', value: import.meta.env.MODE },
    { label: '浏览器', value: navigator.userAgent },
  ];

  return (
    <div className="divide-y">
      <SettingBlock title="FireMail" description="自托管的多账号邮件聚合。">
        <dl className="divide-y text-sm">
          {rows.map((row) => (
            <div key={row.label} className="flex items-start justify-between gap-4 py-2">
              <dt className="shrink-0 text-xs text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 font-mono text-2xs break-all">{row.value}</dd>
            </div>
          ))}
        </dl>

        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => {
            const text = rows.map((row) => `${row.label}: ${row.value}`).join('\n');
            void copyText(text).then((okay) =>
              showInfoToast(okay ? '已复制诊断信息' : '复制失败，请手动选择'),
            );
          }}
        >
          <CopyIcon aria-hidden />
          复制诊断信息
        </Button>
      </SettingBlock>
    </div>
  );
}
