import type { Account } from '@firemail/shared';
import { CheckIcon, CopyIcon, EyeIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { REVEAL_TIMEOUT_MS, useRevealPassword } from '@/hooks/accounts/use-reveal-password';
import { copyText } from '@/lib/accounts/copy';
import { humanizeApiError } from '@/lib/api';

/**
 * 「显示密码」。这是密码管理器式的功能：自己的凭据库，忘了就该能查回来。
 *
 * 但明文的暴露面被压到最小：
 *  - 点开这个浮层才发请求，列表渲染时一个字节都不取
 *    （v1 的洞正是「打开账号页 = 29 份凭据进浏览器内存」）；
 *  - 值只在浮层的局部 state 里，不进 query 缓存；
 *  - {@link REVEAL_TIMEOUT_MS} 之后自动消失，关掉浮层立刻清空。
 */
export function RevealPasswordButton({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { password, isLoading, error, expired, reveal, hide } = useRevealPassword(account.id);

  // 没存密码的账号（纯 OAuth）根本没有可显示的东西
  if (!account.hasPassword) return null;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    setCopied(false);
    if (next) reveal();
    else hide();
  };

  const copy = async () => {
    if (password === null) return;
    setCopied(await copyText(password));
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`显示 ${account.email} 的密码`}
        onClick={() => handleOpenChange(true)}
      >
        <EyeIcon aria-hidden />
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{account.email} 的密码</DialogTitle>
            <DialogDescription>
              约 {REVEAL_TIMEOUT_MS / 1000} 秒后自动隐藏，关闭这个窗口也会立即清除。
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <p className="text-sm text-muted-foreground" role="status">
              正在读取…
            </p>
          ) : error ? (
            <p className="rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground" role="alert">
              {humanizeApiError(error)}
            </p>
          ) : expired ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground" role="status">
                明文已自动隐藏。
              </p>
              <Button variant="outline" size="sm" onClick={reveal}>
                再显示一次
              </Button>
            </div>
          ) : password === null ? null : (
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                {/* 明文只落在这一个节点上，窗口一关就随组件卸载 */}
                <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1.5 font-mono text-sm break-all select-all">
                  {password}
                </code>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="复制密码"
                  onClick={() => void copy()}
                >
                  {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {copied ? '已复制到剪贴板。' : null}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => handleOpenChange(false)}>
              关闭并清除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
