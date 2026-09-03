import { useState } from 'react';
import { FormSkeleton } from '@/components/common/skeletons';
import { SettingBlock, TextField } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import { useSettingsPatch, useUserSettings } from '@/hooks/accounts/use-user-settings';
import { useAccounts } from '@/hooks/use-accounts';
import { isSyncIntervalValid, SYNC_INTERVAL_HINT } from '@/lib/accounts/provider-form';

/**
 * 同步设置。间隔需要校验，所以它是少数几个有显式「保存」按钮的地方
 * —— 其余开关都是立即生效（screens.md §7）。
 */
export function SyncPanel() {
  const settings = useUserSettings();
  const { patch, isSaving } = useSettingsPatch();
  const accountsQuery = useAccounts();
  const [draft, setDraft] = useState<string | null>(null);

  if (settings.isPending) {
    return (
      <div className="py-4">
        <FormSkeleton fields={2} />
      </div>
    );
  }

  const current = String(settings.data?.syncIntervalSeconds ?? 300);
  const value = draft ?? current;
  const valid = isSyncIntervalValid(value);
  const accounts = accountsQuery.data ?? [];
  const paused = accounts.filter((account) => !account.syncEnabled).length;

  return (
    <div className="divide-y">
      <SettingBlock
        title="默认同步间隔"
        description={`新账号会用这个间隔；已有账号在「账号管理 → 详情 → 同步」里单独设置。允许 ${SYNC_INTERVAL_HINT}。`}
      >
        <div className="flex items-end gap-2">
          <TextField
            id="sync-interval"
            label="秒"
            type="number"
            className="w-40"
            value={value}
            error={valid ? undefined : `请填 ${SYNC_INTERVAL_HINT}`}
            onChange={setDraft}
          />
          <Button
            size="sm"
            disabled={!valid || draft === null || draft === current || isSaving}
            onClick={() => {
              patch({ syncIntervalSeconds: Number(value) });
              setDraft(null);
            }}
          >
            保存
          </Button>
        </div>
      </SettingBlock>

      <SettingBlock title="同步状态" description="逐个账号的开关在账号管理里。">
        <p className="text-sm text-muted-foreground">
          共 {accounts.length} 个账号
          {paused > 0 ? `，其中 ${paused} 个已暂停自动同步` : '，全部参与自动同步'}。
        </p>
      </SettingBlock>
    </div>
  );
}
