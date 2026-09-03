import type { ChangePasswordRequest } from '@firemail/shared';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import * as accountsApi from '@/lib/accounts/api';
import { runBatch } from '@/lib/accounts/batch';
import type { SessionView } from '@/lib/accounts/schemas';
import { showErrorToast, showSuccessToast } from '@/lib/undo';

/** 会话与口令。都属于「安全设置」，出错必须说清楚原因。 */

const sessionsKey = ['sessions'] as const;

export function useSessions(): UseQueryResult<SessionView[]> {
  return useQuery({
    queryKey: sessionsKey,
    queryFn: ({ signal }) => accountsApi.fetchSessions(signal),
    staleTime: 30_000,
  });
}

export interface SessionActions {
  revoke: (session: SessionView) => void;
  revokeOthers: (sessions: SessionView[]) => void;
  changePassword: (body: ChangePasswordRequest) => Promise<void>;
  isRevoking: boolean;
  isChangingPassword: boolean;
}

export function useSessionActions(): SessionActions {
  const client = useQueryClient();
  const invalidate = () => void client.invalidateQueries({ queryKey: sessionsKey });

  const revoke = useMutation<number, unknown, SessionView, { rollback: () => void }>({
    mutationFn: async (session) => {
      await accountsApi.revokeSession(session.id);
      return session.id;
    },
    onMutate: async (session) => {
      await client.cancelQueries({ queryKey: sessionsKey });
      const snapshot = client.getQueryData<SessionView[]>(sessionsKey);
      client.setQueryData<SessionView[]>(sessionsKey, (current) =>
        current?.filter((item) => item.id !== session.id),
      );
      return { rollback: () => client.setQueryData(sessionsKey, snapshot) };
    },
    onError: (error, _session, context) => {
      context?.rollback();
      showErrorToast('无法吊销会话', error);
    },
    onSuccess: () => showSuccessToast('已吊销该会话'),
    onSettled: invalidate,
  });

  const revokeOthers = useMutation({
    mutationFn: async (sessions: SessionView[]) => {
      const targets = sessions.filter((session) => !session.current);
      const outcome = await runBatch(targets, (session) => accountsApi.revokeSession(session.id));
      return { requested: targets.length, failed: outcome.rejected.length };
    },
    onSuccess: ({ requested, failed }) => {
      if (failed > 0) showErrorToast(`${failed} 个会话吊销失败`, null);
      else showSuccessToast(`已退出其它 ${requested} 个会话`);
    },
    onError: (error) => showErrorToast('无法吊销其它会话', error),
    onSettled: invalidate,
  });

  const password = useMutation({
    mutationFn: (body: ChangePasswordRequest) => accountsApi.changePassword(body),
    onSuccess: () => {
      showSuccessToast('口令已修改', '其它设备上的会话已被吊销');
      invalidate();
    },
  });

  return {
    revoke: (session) => revoke.mutate(session),
    revokeOthers: (sessions) => revokeOthers.mutate(sessions),
    changePassword: (body) => password.mutateAsync(body),
    isRevoking: revoke.isPending || revokeOthers.isPending,
    isChangingPassword: password.isPending,
  };
}
