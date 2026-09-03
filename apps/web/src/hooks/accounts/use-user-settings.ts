import { DEFAULT_USER_SETTINGS, type UpdateUserSettings, type UserSettings } from '@firemail/shared';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import * as accountsApi from '@/lib/accounts/api';
import { isMissingEndpoint } from '@/lib/api';
import { showErrorToast } from '@/lib/undo';

/**
 * 服务端保存的偏好。**每个开关立即生效并自动保存**，没有「保存」按钮
 * （screens.md §7）：乐观写入，失败回滚并说明原因。
 */

export const settingsKey = ['settings'] as const;

/**
 * 阅读屏（`hooks/mail/use-reading-settings.ts`）用的是同一个查询键，
 * 所以取数行为必须一致：端点缺失时都返回 undefined，而不是一边抛错一边吞掉。
 */
export function useUserSettings(): UseQueryResult<UserSettings | undefined> {
  return useQuery({
    queryKey: settingsKey,
    queryFn: async ({ signal }) => {
      try {
        return await accountsApi.fetchSettings(signal);
      } catch (error) {
        if (isMissingEndpoint(error)) return undefined;
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

export interface SettingsController {
  patch: (patch: UpdateUserSettings) => void;
  isSaving: boolean;
}

export function useSettingsPatch(): SettingsController {
  const client = useQueryClient();

  const mutation = useMutation<UserSettings, unknown, UpdateUserSettings, { rollback: () => void }>({
    mutationFn: (patch) => accountsApi.updateSettings(patch),
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: settingsKey });
      const snapshot = client.getQueryData<UserSettings>(settingsKey);
      client.setQueryData<UserSettings>(settingsKey, {
        ...(snapshot ?? DEFAULT_USER_SETTINGS),
        ...patch,
      });
      return { rollback: () => client.setQueryData(settingsKey, snapshot) };
    },
    onError: (error, _patch, context) => {
      context?.rollback();
      showErrorToast('设置没有保存成功', error);
    },
    onSuccess: (settings) => client.setQueryData(settingsKey, settings),
    onSettled: () => void client.invalidateQueries({ queryKey: settingsKey }),
  });

  return { patch: (patch) => mutation.mutate(patch), isSaving: mutation.isPending };
}
