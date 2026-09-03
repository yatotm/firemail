import { ConstructionIcon } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';

/**
 * 后续 agent 负责的屏幕的占位。**不要**在这里堆临时 UI ——
 * 这些路由已经接进了外壳、键位和数据层，实现时只需要把元素换掉。
 */
export function PlaceholderScreen({ title, note }: { title: string; note: string }) {
  return <EmptyState icon={ConstructionIcon} title={title} description={note} />;
}
