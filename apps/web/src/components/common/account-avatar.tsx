import { accountColor, accountInitial } from '@/lib/account-color';
import { cn } from '@/lib/utils';

/**
 * 账号 avatar：首字母 + 由邮箱哈希派生的身份色。
 * 列表行里**不放头像图片** —— 网络请求 + 隐私追踪 + 扫描噪声。
 */
export function AccountAvatar({
  email,
  displayName,
  className,
  size = 24,
}: {
  email: string;
  displayName?: string | null;
  className?: string;
  size?: number;
}) {
  return (
    <span
      className={cn(
        'fm-account-bar inline-flex shrink-0 items-center justify-center rounded-full font-medium text-background',
        className,
      )}
      style={{
        backgroundColor: accountColor(email),
        width: size,
        height: size,
        fontSize: Math.round(size * 0.45),
      }}
      aria-hidden
    >
      {accountInitial(email, displayName)}
    </span>
  );
}

/** 列表行左侧的 3px 身份色条。 */
export function AccountBar({ email, className }: { email: string; className?: string }) {
  return (
    <span
      className={cn('fm-account-bar w-[3px] shrink-0 rounded-r-xs', className)}
      style={{ backgroundColor: accountColor(email) }}
      aria-hidden
    />
  );
}
