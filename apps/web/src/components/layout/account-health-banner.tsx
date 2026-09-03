import type { Account } from '@firemail/shared';
import { KeyRoundIcon } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';

/**
 * 侧栏最顶的常驻告警条（IA §4 第 1 层）。
 * **数量为 0 时整条不渲染** —— 不留空占位，也不显示「一切正常」的绿条，那是噪声。
 */
export function AccountHealthBanner({
  accounts,
  collapsed = false,
  onNavigate,
}: {
  accounts: Account[];
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const authError = accounts.filter((a) => a.status === 'auth_error').length;
  const failed = accounts.filter((a) => a.status === 'error').length;
  const total = authError + failed;

  if (total === 0) return null;

  const label =
    authError > 0 && failed > 0
      ? `${authError} 个账号需重新授权，${failed} 个同步失败`
      : authError > 0
        ? `${authError} 个账号需重新授权`
        : `${failed} 个账号同步失败`;

  return (
    <Link
      to={`/accounts?status=${authError > 0 ? 'auth_error' : 'error'}`}
      onClick={onNavigate}
      aria-label={label}
      className={cn(
        'flex h-9 items-center gap-2 rounded-md bg-warning-subtle px-2 text-xs font-medium text-warning-subtle-foreground transition-colors hover:brightness-105',
        collapsed && 'justify-center px-0',
      )}
    >
      <KeyRoundIcon className="size-3.5 shrink-0" aria-hidden />
      {collapsed ? (
        <span className="sr-only">{label}</span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{label}</span>
      )}
    </Link>
  );
}
