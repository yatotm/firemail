import type { Account } from '@firemail/shared';
import { useState, type ReactNode } from 'react';
import { AccountFormDialog } from '@/components/accounts/account-form-dialog';
import { ConnectionTestResult } from '@/components/accounts/connection-test-result';
import { SimpleTabs } from '@/components/accounts/simple-tabs';
import { AccountStatusLabel } from '@/components/common/account-status';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { SecretState, Switch } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useAccountEditor } from '@/hooks/accounts/use-account-editor';
import { AUTH_TYPE_LABEL } from '@/lib/accounts/provider-form';
import { PROVIDER_LABEL } from '@/lib/accounts/dashboard';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';

/**
 * 账号详情（`/accounts/:id`，右侧 480）。
 * 凭据永远只显示「已配置 + 替换」，不回显任何密码或 token（accessibility.md 反模式 #15）。
 */
export function AccountDetailSheet({
  account,
  open,
  onOpenChange,
  onToggleSyncEnabled,
  onSetEnabled,
  onSyncNow,
  onReauth,
  onDelete,
}: {
  account: Account;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggleSyncEnabled: (account: Account) => void;
  onSetEnabled: (account: Account, enabled: boolean) => void;
  onSyncNow: (account: Account) => void;
  onReauth: (account: Account) => void;
  onDelete: (account: Account) => void;
}) {
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const editor = useAccountEditor();

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-[30rem]">
          <SheetHeader className="gap-2">
            <SheetTitle className="pr-8 text-base break-all">{account.email}</SheetTitle>
            <SheetDescription asChild>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <AccountStatusLabel status={account.status} />
                <span aria-hidden>·</span>
                <span>{PROVIDER_LABEL[account.provider]}</span>
                <span aria-hidden>·</span>
                <span>{AUTH_TYPE_LABEL[account.authType]}</span>
              </div>
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 px-4">
            <SimpleTabs
              value={tab}
              onValueChange={setTab}
              items={[
                {
                  value: 'overview',
                  label: '概览',
                  content: (
                    <dl className="divide-y text-sm">
                      <Row label="显示名" value={account.displayName ?? '—'} />
                      <Row label="未读" value={String(account.unreadCount)} />
                      <Row
                        label="上次同步"
                        value={
                          <time
                            dateTime={toIsoString(account.lastSyncedAt)}
                            title={formatAbsoluteTime(account.lastSyncedAt)}
                          >
                            {formatRelativeTime(account.lastSyncedAt)}
                          </time>
                        }
                      />
                      {account.authType === 'oauth2' ? (
                        <>
                          <Row
                            label="令牌到期"
                            value={
                              account.oauthTokenExpiresAt
                                ? formatAbsoluteTime(account.oauthTokenExpiresAt)
                                : '未知'
                            }
                          />
                          <Row label="授权范围" value={account.oauthScope ?? '默认'} mono />
                        </>
                      ) : null}
                      {account.lastError ? (
                        <Row label="最近错误" value={account.lastError} mono />
                      ) : null}
                    </dl>
                  ),
                },
                {
                  value: 'connection',
                  label: '连接',
                  content: (
                    <div className="space-y-3">
                      <dl className="divide-y text-sm">
                        <Row
                          label="IMAP"
                          mono
                          value={`${account.imapHost ?? '默认'}:${account.imapPort ?? '—'} ${account.imapSecure ? 'TLS' : 'STARTTLS'}`}
                        />
                        <Row
                          label="SMTP"
                          mono
                          value={`${account.smtpHost ?? '默认'}:${account.smtpPort ?? '—'} ${account.smtpSecure ? 'TLS' : 'STARTTLS'}`}
                        />
                        <Row
                          label="密码"
                          value={<SecretState configured={account.hasPassword} />}
                        />
                        <Row
                          label="OAuth 令牌"
                          value={<SecretState configured={account.hasOAuthToken} />}
                        />
                      </dl>

                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={editor.isTesting}
                          onClick={() => void editor.test(account.id).catch(() => undefined)}
                        >
                          {editor.isTesting ? '测试中…' : '测试连接'}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                          替换凭据
                        </Button>
                        {account.authType === 'oauth2' ? (
                          <Button variant="outline" size="sm" onClick={() => onReauth(account)}>
                            重新授权
                          </Button>
                        ) : null}
                      </div>

                      <ConnectionTestResult
                        result={editor.testResult}
                        error={editor.testError}
                        testing={editor.isTesting}
                      />
                    </div>
                  ),
                },
                {
                  value: 'sync',
                  label: '同步',
                  content: (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-4 py-2">
                        <div>
                          <p className="text-sm font-medium">自动同步</p>
                          <p className="text-xs text-muted-foreground">
                            每 {account.syncIntervalSeconds} 秒拉取一次新邮件
                          </p>
                        </div>
                        <Switch
                          checked={account.syncEnabled}
                          onCheckedChange={() => onToggleSyncEnabled(account)}
                          label={account.syncEnabled ? '暂停自动同步' : '开启自动同步'}
                        />
                      </div>
                      <Button variant="outline" size="sm" onClick={() => onSyncNow(account)}>
                        立即同步一次
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </div>

          <SheetFooter className="flex-row items-center justify-between gap-2 border-t">
            <Button size="sm" onClick={() => setEditing(true)}>
              编辑
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSetEnabled(account, account.status === 'disabled')}
              >
                {account.status === 'disabled' ? '启用' : '停用'}
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
                删除账号
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {editing ? (
        <AccountFormDialog open onOpenChange={setEditing} account={account} />
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`删除 ${account.email}？`}
        description="将同时删除本地缓存的该账号邮件。此操作不可撤销，邮件服务器上的邮件不受影响。"
        confirmLabel="删除账号"
        onConfirm={() => {
          onDelete(account);
          onOpenChange(false);
        }}
      />
    </>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? 'min-w-0 font-mono text-2xs break-all' : 'min-w-0 text-right text-sm'}>
        {value}
      </dd>
    </div>
  );
}
