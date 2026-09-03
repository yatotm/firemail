import { PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN, usernameSchema } from '@firemail/shared';
import { useState } from 'react';
import { SettingRow, Switch, TextField } from '@/components/settings/controls';
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
import { cn } from '@/lib/utils';

const USERNAME_RULE = `${USERNAME_MIN}–${USERNAME_MAX} 位，只允许字母、数字和 . _ -`;

/** 0–3 档，仅作提示，不作强制 —— 真正的下限是 8 位（服务端校验）。 */
function passwordScore(value: string): number {
  if (value.length < PASSWORD_MIN) return 0;
  let score = 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value)) score += 1;
  return Math.min(3, score);
}

const SCORE_LABEL = ['太短', '一般', '不错', '很强'];
const SCORE_CLASS = ['bg-muted', 'bg-destructive', 'bg-warning', 'bg-success'];

export function CreateUserDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { username: string; password: string; isAdmin: boolean }) => Promise<unknown>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const usernameValid = usernameSchema.safeParse(username).success;
  const score = passwordScore(password);
  const canSubmit = usernameValid && password.length >= PASSWORD_MIN && !busy;

  const close = (next: boolean) => {
    if (!next) {
      setUsername('');
      setPassword('');
      setIsAdmin(false);
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCreate({ username, password, isAdmin });
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
          <DialogTitle>新建用户</DialogTitle>
          <DialogDescription>
            新用户默认只能看到自己的邮箱账号。管理员可以管理全部用户。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {error ? (
            <p
              className="rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground"
              aria-live="assertive"
            >
              {error}
            </p>
          ) : null}

          <TextField
            id="new-username"
            label="用户名"
            autoComplete="off"
            required
            value={username}
            hint={USERNAME_RULE}
            error={username && !usernameValid ? USERNAME_RULE : undefined}
            onChange={setUsername}
          />

          <div className="space-y-1.5">
            <TextField
              id="new-user-password"
              label="口令"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              hint={`至少 ${PASSWORD_MIN} 位`}
              onChange={setPassword}
            />
            <div className="flex items-center gap-2">
              <div className="flex h-1 flex-1 gap-1" aria-hidden>
                {[1, 2, 3].map((step) => (
                  <span
                    key={step}
                    className={cn(
                      'h-1 flex-1 rounded-full',
                      score >= step ? SCORE_CLASS[score] : 'bg-muted',
                    )}
                  />
                ))}
              </div>
              <span className="text-2xs text-muted-foreground">{SCORE_LABEL[score]}</span>
            </div>
          </div>

          <SettingRow
            title="管理员"
            description="可以管理用户、重置口令、开关注册"
            control={
              <Switch checked={isAdmin} onCheckedChange={setIsAdmin} label="设为管理员" />
            }
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            取消
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? '创建中…' : '创建用户'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
