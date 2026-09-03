import { useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** 把后果写清楚：`将同时删除该用户的 N 个邮箱账号和本地缓存的邮件。此操作不可撤销。` */
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** 要求输入指定文字才能确认（批量删除账号这类真正不可逆的操作）。 */
  confirmWord?: string;
  onConfirm: () => void | Promise<void>;
}

/**
 * 确认对话框只留给**不可逆**的操作。可撤销的动作一律走乐观更新 + undo toast
 * （interactions.md §4.1）。确认按钮不是默认焦点，默认焦点在「取消」上。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  destructive = true,
  confirmWord,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  const canConfirm = !busy && (!confirmWord || typed.trim() === confirmWord);

  // 关闭（含 Esc / 点遮罩）都会走这里，状态复位不需要 effect
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setTyped('');
      setBusy(false);
    }
    onOpenChange(next);
  };

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      handleOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {confirmWord ? (
          <div className="space-y-2">
            <Label htmlFor="confirm-word" className="text-xs">
              请输入 <span className="font-mono text-foreground">{confirmWord}</span> 以确认
            </Label>
            <Input
              id="confirm-word"
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
        ) : null}

        <AlertDialogFooter>
          {/* 默认焦点必须在取消上，不是确认（accessibility.md §1.2 / #17） */}
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- 规范要求确认框的初始焦点在取消 */}
          <AlertDialogCancel autoFocus>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!canConfirm}
            className={cn(destructive && buttonVariants({ variant: 'destructive' }))}
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
