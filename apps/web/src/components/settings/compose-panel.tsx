import { SIGNATURE_MAX_LENGTH } from '@firemail/shared';
import { useState } from 'react';
import { FormSkeleton } from '@/components/common/skeletons';
import { SelectField, SettingBlock } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAccountEditor } from '@/hooks/accounts/use-account-editor';
import { useSettingsPatch, useUserSettings } from '@/hooks/accounts/use-user-settings';
import { useAccounts } from '@/hooks/use-accounts';
import { showErrorToast } from '@/lib/undo';

/**
 * 撰写设置。签名是**按账号**存的（`accountSchema.signatureHtml`），
 * 所以这里先选账号再编辑，而不是给 29 个账号共用一段签名。
 */
export function ComposePanel() {
  const accountsQuery = useAccounts();
  const settings = useUserSettings();
  const { patch } = useSettingsPatch();
  const editor = useAccountEditor();

  const accounts = accountsQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<string>('');
  const [draft, setDraft] = useState<string | null>(null);

  if (settings.isPending || accountsQuery.isPending) {
    return (
      <div className="py-4">
        <FormSkeleton fields={2} />
      </div>
    );
  }

  const selected = accounts.find((account) => String(account.id) === selectedId) ?? accounts[0];
  const signature = draft ?? selected?.signatureHtml ?? '';

  const defaultOptions = [
    { value: '', label: '每次都问 / 用第一个可用账号' },
    ...accounts.map((account) => ({ value: String(account.id), label: account.email })),
  ];

  const accountOptions = accounts.map((account) => ({
    value: String(account.id),
    label: account.email,
  }));

  return (
    <div className="divide-y">
      <SettingBlock title="默认发件账号" description="新建邮件时预选的账号。">
        <SelectField
          id="default-account"
          label="默认发件账号"
          srOnlyLabel
          value={String(settings.data?.defaultAccountId ?? '')}
          options={defaultOptions}
          onChange={(value) => patch({ defaultAccountId: value ? Number(value) : null })}
          className="max-w-sm"
        />
      </SettingBlock>

      <SettingBlock title="签名" description="按账号分别保存，撰写时自动附在正文末尾。">
        {accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">还没有账号，先去账号管理添加一个。</p>
        ) : (
          <div className="space-y-3">
            <SelectField
              id="signature-account"
              label="选择账号"
              value={selected ? String(selected.id) : ''}
              options={accountOptions}
              onChange={(value) => {
                setSelectedId(value);
                setDraft(null);
              }}
              className="max-w-sm"
            />

            <div className="space-y-1.5">
              <Label htmlFor="signature-body" className="text-xs">
                签名内容
              </Label>
              <Textarea
                id="signature-body"
                rows={5}
                maxLength={SIGNATURE_MAX_LENGTH}
                value={signature}
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={!selected || draft === null || editor.isSaving}
                onClick={() => {
                  if (!selected || draft === null) return;
                  void editor
                    .update(selected.id, { signatureHtml: draft })
                    .then(() => setDraft(null))
                    .catch((error: unknown) => showErrorToast('签名没有保存成功', error));
                }}
              >
                保存签名
              </Button>
              {draft === null ? null : (
                <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                  撤销修改
                </Button>
              )}
            </div>
          </div>
        )}
      </SettingBlock>
    </div>
  );
}
