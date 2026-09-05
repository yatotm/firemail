import { accountProviderSchema, type Account, type AccountProvider } from '@firemail/shared';
import { useState } from 'react';
import { useAccountEditor } from '@/hooks/accounts/use-account-editor';
import { ConnectionTestResult } from '@/components/accounts/connection-test-result';
import { SecretState, SelectField, TextField } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { PROVIDER_LABEL } from '@/lib/accounts/dashboard';
import {
  applyProvider,
  AUTH_TYPE_LABEL,
  emptyForm,
  formFromAccount,
  toCreateRequest,
  toUpdateRequest,
  type AccountFormState,
  type FieldErrors,
} from '@/lib/accounts/provider-form';
import { humanizeApiError, isApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

const PROVIDER_OPTIONS = accountProviderSchema.options.map((provider) => ({
  value: provider,
  label: PROVIDER_LABEL[provider],
}));

/** 表单字段 → DOM id，提交失败时把焦点送到第一个出错的字段（accessibility.md §1.2）。 */
const FIELD_IDS: Record<string, string> = {
  email: 'account-email',
  displayName: 'account-display-name',
  password: 'account-password',
  oauthClientId: 'account-client-id',
  oauthRefreshToken: 'account-refresh-token',
  imapHost: 'account-imap-host',
  imapPort: 'account-imap-port',
  smtpHost: 'account-smtp-host',
  smtpPort: 'account-smtp-port',
  syncIntervalSeconds: 'account-sync-interval',
};

export function AccountFormDialog({
  open,
  onOpenChange,
  account,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 给了就是编辑，没给就是新增。 */
  account?: Account;
}) {
  const editing = account !== undefined;
  const [form, setForm] = useState<AccountFormState>(() =>
    account ? formFromAccount(account) : emptyForm(),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [advanced, setAdvanced] = useState(form.provider === 'imap');
  const editor = useAccountEditor();

  const patch = (next: Partial<AccountFormState>) => setForm((current) => ({ ...current, ...next }));

  const changeProvider = (provider: AccountProvider) => {
    setForm((current) => applyProvider(current, provider));
    setAdvanced(provider === 'imap');
  };

  const failWith = (fields: FieldErrors) => {
    setErrors(fields);
    const first = Object.keys(fields)[0];
    const id = first ? FIELD_IDS[first] : undefined;
    if (id) {
      const element = document.getElementById(id);
      element?.focus();
      element?.scrollIntoView({ block: 'center' });
    }
  };

  const save = async () => {
    if (account) {
      const result = toUpdateRequest(form, account);
      if (!result.ok) {
        failWith(result.errors);
        return false;
      }
      await editor.update(account.id, result.data);
      return true;
    }

    const result = toCreateRequest(form);
    if (!result.ok) {
      failWith(result.errors);
      return false;
    }
    const created = await editor.create(result.data);
    // 新账号最有价值的反馈就是「它到底能不能连上」，所以保存后立刻测一次
    void editor.test(created.id).catch(() => undefined);
    return true;
  };

  const submit = async () => {
    setErrors({});
    try {
      if (await save()) onOpenChange(false);
    } catch (error) {
      const fields = isApiError(error) ? error.fields : undefined;
      failWith(
        fields
          ? Object.fromEntries(
              Object.entries(fields).map(([key, messages]) => [key, messages[0] ?? '不合法']),
            )
          : { form: humanizeApiError(error) },
      );
    }
  };

  const isOAuth = form.authType === 'oauth2';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `编辑 ${account.email}` : '添加账号'}</DialogTitle>
          <DialogDescription>
            {isOAuth
              ? 'Outlook 个人账号只能用 OAuth2：微软已对个人账号关停 IMAP/SMTP 基本认证。'
              : '这些服务商使用密码登录，建议填应用专用密码而不是登录口令。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {errors.form ? (
            <p
              className="rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground"
              aria-live="assertive"
            >
              {errors.form}
            </p>
          ) : null}

          <TextField
            id={FIELD_IDS.email ?? 'account-email'}
            label="邮箱地址"
            type="email"
            autoComplete="email"
            required
            value={form.email}
            error={errors.email}
            onChange={(email) => patch({ email })}
          />

          <TextField
            id={FIELD_IDS.displayName ?? 'account-display-name'}
            label="显示名"
            value={form.displayName}
            error={errors.displayName}
            hint="留空则用邮箱地址"
            onChange={(displayName) => patch({ displayName })}
          />

          <div className="flex items-end gap-3">
            <SelectField
              id="account-provider"
              label="服务商"
              value={form.provider}
              options={PROVIDER_OPTIONS}
              onChange={changeProvider}
              className="flex-1"
            />
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs">认证方式</Label>
              <p className="flex h-8 items-center text-sm text-muted-foreground">
                {AUTH_TYPE_LABEL[form.authType]}
              </p>
            </div>
          </div>

          {isOAuth ? (
            <>
              <TextField
                id={FIELD_IDS.oauthClientId ?? 'account-client-id'}
                label="客户端 ID"
                required={!editing}
                value={form.oauthClientId}
                error={errors.oauthClientId}
                onChange={(oauthClientId) => patch({ oauthClientId })}
              />
              <TextField
                id={FIELD_IDS.oauthRefreshToken ?? 'account-refresh-token'}
                label="Refresh token"
                type="password"
                autoComplete="off"
                required={!editing}
                value={form.oauthRefreshToken}
                error={errors.oauthRefreshToken}
                hint={
                  editing ? (
                    <span className="flex items-center gap-2">
                      当前 <SecretState configured={account.hasOAuthToken} /> · 留空表示不修改
                    </span>
                  ) : undefined
                }
                onChange={(oauthRefreshToken) => patch({ oauthRefreshToken })}
              />
            </>
          ) : (
            <TextField
              id={FIELD_IDS.password ?? 'account-password'}
              label="密码 / 应用专用密码"
              type="password"
              autoComplete="new-password"
              required={!editing}
              value={form.password}
              error={errors.password}
              hint={
                editing ? (
                  <span className="flex items-center gap-2">
                    当前 <SecretState configured={account.hasPassword} /> · 留空表示不修改
                  </span>
                ) : undefined
              }
              onChange={(password) => patch({ password })}
            />
          )}

          <div className="rounded-md border">
            <button
              type="button"
              onClick={() => setAdvanced((current) => !current)}
              aria-expanded={advanced}
              className="focus-ring-inset flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-accent/50"
            >
              连接参数
              <span className="text-xs text-muted-foreground">
                {advanced ? '收起' : '已按服务商填好'}
              </span>
            </button>

            {advanced ? (
              <div className="space-y-3 border-t p-3">
                <div className="flex gap-3">
                  <TextField
                    id={FIELD_IDS.imapHost ?? 'account-imap-host'}
                    label="IMAP 服务器"
                    className="flex-1"
                    value={form.imapHost}
                    error={errors.imapHost}
                    onChange={(imapHost) => patch({ imapHost })}
                  />
                  <TextField
                    id={FIELD_IDS.imapPort ?? 'account-imap-port'}
                    label="端口"
                    type="number"
                    className="w-24"
                    value={form.imapPort}
                    error={errors.imapPort}
                    onChange={(imapPort) => patch({ imapPort })}
                  />
                </div>
                <label htmlFor="account-imap-secure" className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id="account-imap-secure"
                    checked={form.imapSecure}
                    onCheckedChange={(imapSecure) => patch({ imapSecure })}
                  />
                  IMAP 使用 TLS
                </label>

                <div className="flex gap-3">
                  <TextField
                    id={FIELD_IDS.smtpHost ?? 'account-smtp-host'}
                    label="SMTP 服务器"
                    className="flex-1"
                    value={form.smtpHost}
                    error={errors.smtpHost}
                    onChange={(smtpHost) => patch({ smtpHost })}
                  />
                  <TextField
                    id={FIELD_IDS.smtpPort ?? 'account-smtp-port'}
                    label="端口"
                    type="number"
                    className="w-24"
                    value={form.smtpPort}
                    error={errors.smtpPort}
                    onChange={(smtpPort) => patch({ smtpPort })}
                  />
                </div>
                <label htmlFor="account-smtp-secure" className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id="account-smtp-secure"
                    checked={form.smtpSecure}
                    onCheckedChange={(smtpSecure) => patch({ smtpSecure })}
                  />
                  SMTP 直连 TLS（否则用 STARTTLS）
                </label>
              </div>
            ) : null}
          </div>

          {/* 同步间隔是全局的，在「设置 → 同步」里一处调完管所有账号，这里不再单开一个 */}
          <div className="flex items-end gap-3">
            <div className="flex h-9 items-center gap-2">
              <Switch
                checked={form.syncEnabled}
                onCheckedChange={(syncEnabled) => patch({ syncEnabled })}
                label="启用自动同步"
                id="account-sync-enabled"
              />
              <Label htmlFor="account-sync-enabled" className="text-sm">
                启用自动同步
              </Label>
            </div>
          </div>

          {editing ? (
            <ConnectionTestResult
              result={editor.testResult}
              error={editor.testError}
              testing={editor.isTesting}
            />
          ) : null}
        </div>

        <DialogFooter className={cn(editing && 'sm:justify-between')}>
          {editing ? (
            <Button
              variant="outline"
              onClick={() => void editor.test(account.id).catch(() => undefined)}
              disabled={editor.isTesting}
            >
              {editor.isTesting ? '测试中…' : '测试连接'}
            </Button>
          ) : null}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button onClick={() => void submit()} disabled={editor.isSaving}>
              {editing ? '保存' : '添加账号'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
