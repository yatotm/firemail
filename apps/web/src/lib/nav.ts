import { VIEW_TO_SPECIAL_USE, type FolderSpecialUse } from '@firemail/shared';
import {
  Archive,
  FileText,
  Hash,
  Inbox,
  type LucideIcon,
  Mail,
  Paperclip,
  Send,
  ShieldAlert,
  Star,
  StickyNote,
  Trash2,
} from 'lucide-react';

/**
 * 导航模型：作用域（scope）× 视图（view）两个正交维度。
 * 切 scope 不改 view，切 view 不改 scope —— 这是整个 IA 的不变量
 * （docs/design/information-architecture.md §2.1）。
 */

export type MailScope = { kind: 'all' } | { kind: 'account'; accountId: number };

export const ALL_SCOPE: MailScope = { kind: 'all' };

export const SMART_VIEWS = ['unread', 'starred', 'codes', 'attachments'] as const;
export const FOLDER_VIEWS = [
  'inbox',
  'sent',
  'drafts',
  'archive',
  'junk',
  'deleted',
  'notes',
  'outbox',
] as const;

export type SmartView = (typeof SMART_VIEWS)[number];
export type FolderView = (typeof FOLDER_VIEWS)[number];
/** `f<folderId>`：账号自定义文件夹。 */
export type CustomFolderView = `f${number}`;
export type MailView = SmartView | FolderView | CustomFolderView;

export const DEFAULT_VIEW: MailView = 'inbox';

export interface ViewMeta {
  view: FolderView | SmartView;
  label: string;
  icon: LucideIcon;
  /** `g` 前缀的第二个键。 */
  gotoKey?: string;
}

/**
 * URL 与界面用「已删除 deleted」，IMAP 枚举里是 `trash`。
 * 映射的唯一来源是 shared 的 `VIEW_TO_SPECIAL_USE`，这里只做一层查表，不重写一份。
 */
export function specialUseForView(view: MailView): FolderSpecialUse | null {
  return view in VIEW_TO_SPECIAL_USE
    ? VIEW_TO_SPECIAL_USE[view as keyof typeof VIEW_TO_SPECIAL_USE]
    : null;
}

export const VIEW_META: Record<FolderView | SmartView, ViewMeta> = {
  inbox: { view: 'inbox', label: '全部收件箱', icon: Inbox, gotoKey: 'i' },
  unread: { view: 'unread', label: '未读', icon: Mail, gotoKey: 'u' },
  starred: { view: 'starred', label: '星标', icon: Star, gotoKey: 's' },
  codes: { view: 'codes', label: '验证码', icon: Hash, gotoKey: 'v' },
  attachments: { view: 'attachments', label: '附件', icon: Paperclip },
  sent: { view: 'sent', label: '已发送', icon: Send, gotoKey: 't' },
  drafts: { view: 'drafts', label: '草稿', icon: FileText, gotoKey: 'd' },
  archive: { view: 'archive', label: '归档', icon: Archive, gotoKey: 'e' },
  junk: { view: 'junk', label: '垃圾邮件', icon: ShieldAlert, gotoKey: 'j' },
  deleted: { view: 'deleted', label: '已删除', icon: Trash2, gotoKey: 'b' },
  notes: { view: 'notes', label: '便笺', icon: StickyNote, gotoKey: 'n' },
  outbox: { view: 'outbox', label: '发件箱', icon: Send, gotoKey: 'o' },
};

/** 侧栏顶部常驻的 4 个高频视图（screens.md §1.1）。 */
export const PRIMARY_VIEWS: (FolderView | SmartView)[] = ['inbox', 'unread', 'starred', 'codes'];

/** 默认折叠的「更多文件夹」组。 */
export const SECONDARY_VIEWS: (FolderView | SmartView)[] = [
  'sent',
  'drafts',
  'archive',
  'junk',
  'deleted',
  'notes',
  'outbox',
];

const VIEW_BY_GOTO_KEY = new Map<string, FolderView | SmartView>(
  Object.values(VIEW_META)
    .filter((meta): meta is ViewMeta & { gotoKey: string } => Boolean(meta.gotoKey))
    .map((meta) => [meta.gotoKey, meta.view]),
);

export function viewForGotoKey(key: string): FolderView | SmartView | null {
  return VIEW_BY_GOTO_KEY.get(key.toLowerCase()) ?? null;
}

export function isKnownView(value: string): value is MailView {
  return value in VIEW_META || /^f[1-9]\d*$/.test(value);
}

export function parseView(value: string | undefined): MailView {
  return value && isKnownView(value) ? value : DEFAULT_VIEW;
}

export function parseScope(value: string | undefined): MailScope {
  const match = /^a([1-9]\d*)$/.exec(value ?? '');
  return match?.[1] ? { kind: 'account', accountId: Number(match[1]) } : ALL_SCOPE;
}

export function formatScope(scope: MailScope): string {
  return scope.kind === 'all' ? 'all' : `a${scope.accountId}`;
}

export function scopeAccountId(scope: MailScope): number | null {
  return scope.kind === 'account' ? scope.accountId : null;
}

export function viewLabel(view: MailView, folderName?: string): string {
  if (view in VIEW_META) return VIEW_META[view as FolderView | SmartView].label;
  return folderName ?? '文件夹';
}

/** `/mail/:scope/:view[/:messageId]` —— 导航状态全在 URL 里，刷新和后退才不会丢。 */
export function mailPath(scope: MailScope, view: MailView, messageId?: number | null): string {
  const base = `/mail/${formatScope(scope)}/${view}`;
  return messageId ? `${base}/${messageId}` : base;
}

export const routePaths = {
  login: '/login',
  mail: '/mail',
  search: '/search',
  accounts: '/accounts',
  settings: '/settings',
  adminUsers: '/admin/users',
} as const;
