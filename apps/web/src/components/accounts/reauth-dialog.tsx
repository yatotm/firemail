import type { Account } from '@firemail/shared';
import {
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useReauth } from '@/hooks/accounts/use-reauth';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { canRestart, formatCountdown, REAUTH_PHASE_LABEL } from '@/lib/accounts/device-code';
import { copyText } from '@/lib/accounts/copy';
import { humanizeApiError } from '@/lib/api';
import { spellOut } from '@/lib/format';
import { showInfoToast } from '@/lib/undo';
import { cn } from '@/lib/utils';

/**
 * 设备码重新授权向导。
 *
 * refresh token 真的死掉时这是唯一的恢复路径，所以三件事必须做对：
 * 用户码要大、要能一键复制；验证地址要能直接点开；**终态要诚实** ——
 * 过期就说过期，不要永远转圈（旧版就是这么挂着的）。
 */
export function ReauthDialog({
  account,
  open,
  onOpenChange,
}: {
  account: Account;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { view, start, cancel, isStarting, isCancelling, error } = useReauth(account.id, open);
  const autoStarted = useRef(false);

  // 打开就自动发起；如果服务端已有进行中的流程，会先被轮询读回来，这里就不再发起
  useEffect(() => {
    if (!open) {
      autoStarted.current = false;
      return;
    }
    if (autoStarted.current || isStarting) return;
    if (view.phase === 'idle') {
      autoStarted.current = true;
      start();
    }
  }, [open, view.phase, isStarting, start]);

  const pending = view.phase === 'pending';
  // 发起就失败时不能还写「未开始」——那会让人以为按钮没生效
  const phaseLabel =
    error && view.phase === 'idle' ? '发起授权失败' : REAUTH_PHASE_LABEL[view.phase];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>重新授权 {account.email}</DialogTitle>
          <DialogDescription>
            在另一台设备或浏览器标签里打开验证地址，输入下面的用户码完成登录。
            授权成功后账号会自动恢复同步。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4" aria-live="polite">
          <p className="flex items-center gap-2 text-sm">
            <PhaseIcon phase={error && view.phase === 'idle' ? 'failed' : view.phase} />
            {phaseLabel}
            {pending ? (
              <span className="tnum ml-auto text-xs text-muted-foreground">
                剩余 {formatCountdown(view.remainingMs)}
              </span>
            ) : null}
          </p>

          {view.userCode && (pending || view.phase === 'success') ? (
            <div className="space-y-3 rounded-lg border bg-card p-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">用户码</p>
                <div className="flex items-center gap-2">
                  <code
                    className="flex-1 rounded-sm bg-code-bg px-3 py-2 font-mono text-2xl tracking-[0.2em] text-code-foreground"
                    aria-label={`用户码 ${spellOut(view.userCode)}`}
                  >
                    {view.userCode}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="复制用户码"
                    onClick={() => {
                      void copyText(view.userCode ?? '').then((okay) => {
                        showInfoToast(okay ? `已复制 ${view.userCode ?? ''}` : '复制失败，请手动选择');
                      });
                    }}
                  >
                    <CopyIcon aria-hidden />
                  </Button>
                </div>
              </div>

              {view.verificationUri ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">验证地址</p>
                  <div className="flex items-center gap-2">
                    <a
                      href={view.verificationUri}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="focus-ring min-w-0 flex-1 truncate rounded-sm text-sm text-primary underline-offset-4 hover:underline"
                    >
                      {view.verificationUri}
                    </a>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="在新标签页打开验证地址"
                      asChild
                    >
                      <a href={view.verificationUri} target="_blank" rel="noreferrer noopener">
                        <ExternalLinkIcon aria-hidden />
                      </a>
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {view.phase === 'success' ? (
            <p className="rounded-md bg-success-subtle px-3 py-2 text-sm text-success-subtle-foreground">
              授权已完成，账号凭据已更新。
            </p>
          ) : null}

          {view.phase === 'expired' ? (
            <p className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-foreground">
              设备码有效期已过（服务端有 15 分钟硬上限）。重新发起会生成一个新的用户码。
            </p>
          ) : null}

          {view.phase === 'failed' ? (
            <div className="space-y-1 rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground">
              <p>{view.errorMessage ?? '授权失败'}</p>
              {view.errorCode ? (
                <code className="font-mono text-2xs">{view.errorCode}</code>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p className="rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground">
              {humanizeApiError(error)}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          {pending ? (
            <Button variant="outline" onClick={cancel} disabled={isCancelling}>
              取消授权
            </Button>
          ) : null}
          {canRestart(view.phase) ? (
            <Button onClick={start} disabled={isStarting}>
              {view.phase === 'idle' ? '发起授权' : '重新发起'}
            </Button>
          ) : null}
          <Button variant={view.phase === 'success' ? 'default' : 'ghost'} onClick={() => onOpenChange(false)}>
            {view.phase === 'success' ? '完成' : '关闭'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PhaseIcon({ phase }: { phase: string }) {
  if (phase === 'success') {
    return <CheckCircle2Icon className="size-4 text-success" aria-hidden />;
  }
  if (phase === 'failed' || phase === 'expired') {
    return <TriangleAlertIcon className="size-4 text-warning" aria-hidden />;
  }
  return (
    <KeyRoundIcon className={cn('size-4 text-muted-foreground', phase === 'pending' && 'text-primary')} aria-hidden />
  );
}
