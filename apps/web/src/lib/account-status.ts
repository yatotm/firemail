import type { AccountStatus } from '@firemail/shared';
import { CircleIcon, KeyRoundIcon, TriangleAlertIcon, type LucideIcon } from 'lucide-react';

/**
 * `accountStatusSchema` 四个值到颜色 / 图标 / 文案的唯一权威映射（tokens.md §2.4）。
 * 任何组件不得自行定义 —— 尤其不得用同一个红色表示所有异常：
 * `auth_error` 是用户自己能修的（重新授权），`error` 是系统性故障。
 */
export interface StatusMeta {
  label: string;
  /** 文本/图标色 */
  className: string;
  /** 徽章底色 */
  subtleClassName: string;
  icon: LucideIcon | null;
  /** 主操作文案，没有则不显示按钮。 */
  action: string | null;
}

export const ACCOUNT_STATUS_META: Record<AccountStatus, StatusMeta> = {
  active: {
    label: '正常',
    className: 'text-success',
    subtleClassName: 'bg-success-subtle text-success-subtle-foreground',
    icon: null,
    action: null,
  },
  auth_error: {
    label: '需重新授权',
    className: 'text-warning',
    subtleClassName: 'bg-warning-subtle text-warning-subtle-foreground',
    icon: KeyRoundIcon,
    action: '重新授权',
  },
  error: {
    label: '同步失败',
    className: 'text-destructive',
    subtleClassName: 'bg-destructive-subtle text-destructive-subtle-foreground',
    icon: TriangleAlertIcon,
    action: '查看错误',
  },
  disabled: {
    label: '已停用',
    className: 'text-muted-foreground',
    subtleClassName: 'bg-muted text-muted-foreground',
    icon: CircleIcon,
    action: '启用',
  },
};
