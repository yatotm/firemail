import type { User } from '@firemail/shared';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useCallback } from 'react';
import * as accountsApi from '@/lib/accounts/api';
import { showErrorToast, showSuccessToast } from '@/lib/undo';

/** 用户管理的数据层。整组接口只对管理员开放，路由层已经先挡过一次。 */

const usersKey = ['users'] as const;
const registrationKey = ['users', 'registration'] as const;

export function useUsers(): UseQueryResult<User[]> {
  return useQuery({
    queryKey: usersKey,
    queryFn: ({ signal }) => accountsApi.fetchUsers(signal),
    staleTime: 30_000,
  });
}

export function useRegistrationAllowed(): UseQueryResult<boolean> {
  return useQuery({
    queryKey: registrationKey,
    queryFn: ({ signal }) => accountsApi.fetchRegistrationAllowed(signal),
    staleTime: 60_000,
  });
}

export interface UserActions {
  create: (input: accountsApi.CreateUserInput) => Promise<User>;
  setAdmin: (user: User, isAdmin: boolean) => void;
  resetPassword: (id: number, newPassword: string) => Promise<void>;
  remove: (user: User) => Promise<void>;
  setRegistration: (allowed: boolean) => void;
  isMutating: boolean;
}

export function useUserActions(): UserActions {
  const client = useQueryClient();
  const invalidate = useCallback(() => {
    void client.invalidateQueries({ queryKey: usersKey });
  }, [client]);

  const create = useMutation({
    mutationFn: (input: accountsApi.CreateUserInput) => accountsApi.createUser(input),
    onSuccess: (user) => {
      showSuccessToast('已创建用户', user.username);
      invalidate();
    },
  });

  const admin = useMutation<User, unknown, { user: User; isAdmin: boolean }, { rollback: () => void }>({
    mutationFn: ({ user, isAdmin }) => accountsApi.setUserAdmin(user.id, isAdmin),
    onMutate: async ({ user, isAdmin }) => {
      await client.cancelQueries({ queryKey: usersKey });
      const snapshot = client.getQueryData<User[]>(usersKey);
      client.setQueryData<User[]>(usersKey, (current) =>
        current?.map((item) => (item.id === user.id ? { ...item, isAdmin } : item)),
      );
      return { rollback: () => client.setQueryData(usersKey, snapshot) };
    },
    onError: (error, _variables, context) => {
      context?.rollback();
      showErrorToast('无法修改管理员权限', error);
    },
    onSettled: invalidate,
  });

  const resetPassword = useMutation({
    mutationFn: ({ id, newPassword }: { id: number; newPassword: string }) =>
      accountsApi.resetUserPassword(id, newPassword),
    onSuccess: () => showSuccessToast('已重置口令', '该用户的所有会话已被吊销'),
  });

  const remove = useMutation({
    mutationFn: (user: User) => accountsApi.deleteUser(user.id),
    onSuccess: (_data, user) => {
      showSuccessToast('已删除用户', user.username);
      invalidate();
    },
    onError: (error) => showErrorToast('删除用户失败', error),
  });

  const registration = useMutation<boolean, unknown, boolean, { rollback: () => void }>({
    mutationFn: (allowed: boolean) => accountsApi.setRegistrationAllowed(allowed),
    onMutate: async (allowed) => {
      await client.cancelQueries({ queryKey: registrationKey });
      const snapshot = client.getQueryData<boolean>(registrationKey);
      client.setQueryData(registrationKey, allowed);
      return { rollback: () => client.setQueryData(registrationKey, snapshot) };
    },
    onError: (error, _allowed, context) => {
      context?.rollback();
      showErrorToast('无法修改注册开关', error);
    },
    onSettled: () => void client.invalidateQueries({ queryKey: registrationKey }),
  });

  return {
    create: (input) => create.mutateAsync(input),
    setAdmin: (user, isAdmin) => admin.mutate({ user, isAdmin }),
    resetPassword: (id, newPassword) => resetPassword.mutateAsync({ id, newPassword }),
    remove: (user) => remove.mutateAsync(user),
    setRegistration: (allowed) => registration.mutate(allowed),
    isMutating:
      create.isPending ||
      admin.isPending ||
      resetPassword.isPending ||
      remove.isPending ||
      registration.isPending,
  };
}
