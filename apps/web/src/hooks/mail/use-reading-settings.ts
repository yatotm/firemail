import { userSettingsSchema, type UserSettings } from '@firemail/shared';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api, isMissingEndpoint } from '@/lib/api';
import { mailEndpoints } from '@/lib/mail/endpoints';
import { mailKeys } from '@/lib/mail/keys';
import { showErrorToast, showSuccessToast } from '@/lib/undo';

/**
 * 阅读相关的服务端偏好：远程图片策略与信任域名。
 *
 * 这两项**必须在服务端**：换设备要保留，而且是安全设置 —— 只存前端等于每台设备各信各的。
 * 设置屏由别的 agent 负责，这里只读 + 只加信任域名，不做完整的设置表单。
 */
export function useReadingSettings(): UseQueryResult<UserSettings | undefined> {
  return useQuery({
    queryKey: mailKeys.settings,
    queryFn: async ({ signal }) => {
      try {
        return await api.get(mailEndpoints.settings, { schema: userSettingsSchema, signal });
      } catch (error) {
        if (isMissingEndpoint(error)) return undefined;
        throw error;
      }
    },
    staleTime: 5 * 60_000,
  });
}

export function useTrustDomain() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ['trust-domain'],
    mutationFn: async (domains: string[]) => {
      const current = queryClient.getQueryData<UserSettings>(mailKeys.settings);
      const merged = [...new Set([...(current?.trustedSenderDomains ?? []), ...domains])];
      return api.patch(mailEndpoints.settings, { trustedSenderDomains: merged }, {
        schema: userSettingsSchema,
      });
    },
    onSuccess: (settings, domains) => {
      queryClient.setQueryData(mailKeys.settings, settings);
      void queryClient.invalidateQueries({ queryKey: mailKeys.bodies });
      showSuccessToast(`已信任 ${domains.join('、')}`, '之后这些域名的图片会直接显示');
    },
    onError: (error) => showErrorToast('无法保存信任域名', error),
  });
}

/** `always` 直接显示、`never` 永不显示、`ask`（默认）先拦截再问。 */
export function shouldShowRemoteImages(settings: UserSettings | undefined): boolean {
  return settings?.remoteImages === 'always';
}
