import { PASSWORD_MIN, type User } from '@firemail/shared';
import { useState } from 'react';
import { TextField } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { humanizeApiError } from '@/lib/api';

/** 重置他人口令会吊销其全部会话，这一点必须写在对话框里而不是藏在文档里。 */
export function ResetPasswordDialog({
  user,
  open,
  onOpenChange,
  onReset,
}: {
  user: User;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReset: (id: number, newPassword: string) => Promise<unknown>;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = (next: boolean) => {
    if (!next) {
      setPassword('');
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onReset(user.id, password);
      close(false);
    } catch (caught) {
      setError(humanizeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>重置 {user.username} 的口令</DialogTitle>
          <DialogDescription>
            重置后该用户当前登录的所有设备都会被登出，需要用新口令重新登录。
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p
            className="rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground"
            aria-live="assertive"
          >
            {error}
          </p>
        ) : null}

        <TextField
          id="reset-password"
          label="新口令"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          hint={`至少 ${PASSWORD_MIN} 位`}
          onChange={setPassword}
        />

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            取消
          </Button>
          <Button disabled={password.length < PASSWORD_MIN || busy} onClick={() => void submit()}>
            {busy ? '提交中…' : '重置口令'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
