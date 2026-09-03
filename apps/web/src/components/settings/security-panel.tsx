import { PASSWORD_MIN } from '@firemail/shared';
import { useState } from 'react';
import { TableSkeleton } from '@/components/common/skeletons';
import { ErrorState } from '@/components/common/error-state';
import { SettingBlock, TextField } from '@/components/settings/controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSessionActions, useSessions } from '@/hooks/accounts/use-sessions';
import { humanizeApiError, isApiError } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';

/** 改口令 + 会话管理。两者都在这里，因为「我怀疑账号被别人登了」时要一起做。 */
export function SecurityPanel() {
  return (
    <div className="divide-y">
      <ChangePasswordForm />
      <SessionList />
    </div>
  );
}

function ChangePasswordForm() {
  const { changePassword, isChangingPassword } = useSessionActions();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (next.length < PASSWORD_MIN) {
      setError(`新口令至少 ${PASSWORD_MIN} 位`);
      return;
    }
    if (next !== confirm) {
      setError('两次输入的新口令不一致');
      return;
    }
    if (next === current) {
      setError('新口令不能与当前口令相同');
      return;
    }

    setError(null);
    try {
      await changePassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : humanizeApiError(caught));
    }
  };

  return (
    <SettingBlock title="修改口令" description="改完之后，其它设备上的会话会被立刻吊销。">
      <form
        className="max-w-sm space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input type="text" name="username" autoComplete="username" hidden readOnly value="" />
        <TextField
          id="current-password"
          label="当前口令"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={setCurrent}
        />
        <TextField
          id="new-password"
          label="新口令"
          type="password"
          autoComplete="new-password"
          hint={`至少 ${PASSWORD_MIN} 位`}
          value={next}
          onChange={setNext}
        />
        <TextField
          id="confirm-password"
          label="确认新口令"
          type="password"
          autoComplete="new-password"
          error={error ?? undefined}
          value={confirm}
          onChange={setConfirm}
        />
        <Button type="submit" size="sm" disabled={isChangingPassword}>
          {isChangingPassword ? '提交中…' : '修改口令'}
        </Button>
      </form>
    </SettingBlock>
  );
}

function SessionList() {
  const sessions = useSessions();
  const { revoke, revokeOthers, isRevoking } = useSessionActions();

  const items = sessions.data ?? [];
  const others = items.filter((session) => !session.current);

  return (
    <SettingBlock
      title="活动会话"
      description="每次登录会创建一条会话。发现不认识的设备就吊销它。"
    >
      {sessions.isPending ? (
        <div aria-busy="true">
          <TableSkeleton rows={3} columns={3} />
        </div>
      ) : sessions.isError ? (
        <ErrorState
          title="无法加载会话列表"
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
        />
      ) : (
        <>
          <ul className="divide-y rounded-md border">
            {items.map((session) => (
              <li key={session.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2">
                    <span className="truncate" title={session.userAgent ?? undefined}>
                      {session.userAgent ?? '未知设备'}
                    </span>
                    {session.current ? <Badge variant="success">当前会话</Badge> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {session.ip ?? '未知来源'} ·{' '}
                    <time
                      dateTime={toIsoString(session.lastUsedAt ?? session.createdAt)}
                      title={formatAbsoluteTime(session.lastUsedAt ?? session.createdAt)}
                    >
                      最近活跃 {formatRelativeTime(session.lastUsedAt ?? session.createdAt)}
                    </time>
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={session.current || isRevoking}
                  onClick={() => revoke(session)}
                >
                  {session.current ? '不可吊销' : '吊销'}
                </Button>
              </li>
            ))}
          </ul>

          {others.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={isRevoking}
              onClick={() => revokeOthers(items)}
            >
              退出其它 {others.length} 个会话
            </Button>
          ) : null}
        </>
      )}
    </SettingBlock>
  );
}
