import { HashIcon, InboxIcon, SearchXIcon } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';
import type { MailView } from '@/lib/nav';

export interface ListEmptyStateProps {
  view: MailView;
  /** 当前生效的筛选，回显给用户看是被什么筛掉的。 */
  activeFilters: string[];
  onClearFilters: () => void;
  onSync: () => void;
}

/**
 * 「筛选后无结果」和「本来就没有数据」必须是不同文案 ——
 * 前者要给出清除筛选的路（screens.md §10.3）。
 */
export function ListEmptyState({
  view,
  activeFilters,
  onClearFilters,
  onSync,
}: ListEmptyStateProps) {
  if (activeFilters.length > 0) {
    return (
      <EmptyState
        icon={SearchXIcon}
        title="没有符合条件的邮件"
        description={`当前筛选：${activeFilters.join('、')}`}
        actions={
          <Button variant="default" size="sm" onClick={onClearFilters}>
            清除筛选
          </Button>
        }
      />
    );
  }

  if (view === 'codes') {
    return (
      <EmptyState
        icon={HashIcon}
        title="近 7 天没有验证码邮件"
        description="验证码会自动从主题和摘要中识别，全部在本地完成"
        actions={
          <Button variant="ghost" size="sm" onClick={onSync}>
            立即同步
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      icon={InboxIcon}
      title="这里是空的"
      description="所有账号都没有符合这个视图的邮件"
      actions={
        <Button variant="default" size="sm" onClick={onSync}>
          立即同步
        </Button>
      }
    />
  );
}
