import type { Account } from '@firemail/shared';
import { Navigate, useNavigate, useOutletContext, useParams } from 'react-router';
import { AccountDetailSheet } from '@/components/accounts/account-detail-sheet';
import { AccountFormDialog } from '@/components/accounts/account-form-dialog';
import { ImportDialog } from '@/components/accounts/import-dialog';
import { ReauthDialog } from '@/components/accounts/reauth-dialog';
import { useAccountActions } from '@/hooks/accounts/use-account-actions';
import { useAccount } from '@/hooks/accounts/use-account-editor';
import type { AccountsOutletContext } from '@/routes/accounts/accounts-page';

/**
 * `/accounts/*` 的浮层全部是真实路由（IA §5）：
 * 刷新页面还在同一个对话框里，Esc / 后退键回到列表，链接可以直接分享。
 */

const LIST_PATH = '/accounts';

function useRouteAccount(): { account: Account | null; loading: boolean } {
  const params = useParams();
  const id = Number(params.id);
  const query = useAccount(Number.isInteger(id) && id > 0 ? id : null);
  return { account: query.data ?? null, loading: query.isPending };
}

export function NewAccountRoute() {
  const navigate = useNavigate();
  return (
    <AccountFormDialog
      open
      onOpenChange={(open) => {
        if (!open) void navigate(LIST_PATH);
      }}
    />
  );
}

export function ImportAccountsRoute() {
  const navigate = useNavigate();
  const { accounts } = useOutletContext<AccountsOutletContext>();
  return (
    <ImportDialog
      open
      existingEmails={accounts.map((account) => account.email)}
      onOpenChange={(open) => {
        if (!open) void navigate(LIST_PATH);
      }}
    />
  );
}

export function AccountDetailRoute() {
  const navigate = useNavigate();
  const actions = useAccountActions();
  const { account, loading } = useRouteAccount();

  if (!account) return loading ? null : <Navigate to={LIST_PATH} replace />;

  const close = () => void navigate(LIST_PATH);

  return (
    <AccountDetailSheet
      account={account}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onToggleSyncEnabled={actions.toggleSyncEnabled}
      onSetEnabled={(target, enabled) => actions.setEnabled([target], enabled)}
      onSyncNow={(target) => actions.syncNow([target])}
      onReauth={(target) => void navigate(`/accounts/${target.id}/reauth`)}
      onDelete={(target) => {
        void actions.remove([target]).then(close);
      }}
    />
  );
}

export function ReauthRoute() {
  const navigate = useNavigate();
  const { account, loading } = useRouteAccount();

  if (!account) return loading ? null : <Navigate to={LIST_PATH} replace />;
  // 密码账号没有设备码流程，直接回详情去换密码
  if (account.authType !== 'oauth2') {
    return <Navigate to={`/accounts/${account.id}`} replace />;
  }

  return (
    <ReauthDialog
      account={account}
      open
      onOpenChange={(open) => {
        if (!open) void navigate(LIST_PATH);
      }}
    />
  );
}
