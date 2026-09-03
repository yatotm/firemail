import { RefreshCwIcon } from 'lucide-react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { Button } from '@/components/ui/button';
import { humanizeApiError } from '@/lib/api';

/**
 * 路由级错误边界。react-router 自带的默认页面是给开发者看的（「💿 Hey developer」），
 * 自托管用户看到的必须是能复制去搜的真实错误 + 一个重新加载按钮。
 */
export function RouteError() {
  const error = useRouteError();

  const title = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : '界面出错了';
  const detail: unknown = isRouteErrorResponse(error) ? error.data : humanizeApiError(error);
  const stack = error instanceof Error ? error.stack : null;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="max-w-prose text-sm text-muted-foreground">{String(detail)}</p>

      {stack ? (
        <details className="w-full max-w-2xl text-left">
          <summary className="cursor-pointer text-xs text-muted-foreground">技术细节</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-2xs whitespace-pre-wrap">
            {stack}
          </pre>
        </details>
      ) : null}

      <Button size="sm" onClick={() => window.location.reload()}>
        <RefreshCwIcon aria-hidden />
        重新加载
      </Button>
    </div>
  );
}
