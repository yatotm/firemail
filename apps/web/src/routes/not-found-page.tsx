import { FileQuestionIcon } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <EmptyState
      icon={FileQuestionIcon}
      title="页面不存在"
      description="这个地址没有对应的页面，可能是链接过期或输入有误。"
      actions={
        <Button asChild size="sm">
          <Link to="/">返回收件箱</Link>
        </Button>
      }
    />
  );
}
