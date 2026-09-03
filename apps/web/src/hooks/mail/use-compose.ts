import type { Account, EmailAddress, Message, SendMessageRequest } from '@firemail/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { uploadAttachment } from '@/lib/mail/upload';
import { readJson, removeStorage, writeJson } from '@/lib/storage';
import { humanizeApiError } from '@/lib/api';
import {
  draftFromMessage,
  draftStorageKey,
  emptyDraft,
  formatComposeParam,
  fromPersisted,
  isDraftDirty,
  parseComposeParam,
  toPersisted,
  type ComposeDraft,
  type ComposeIntent,
  type ComposeKind,
  type DraftAttachment,
  type PersistedDraft,
} from '@/lib/mail/compose';

/**
 * 撰写状态。
 *
 * URL 是唯一真源（`?compose=reply:1234`），草稿内容存在本地：
 * F5 之后回到同一个撰写上下文，且内容还在（accessibility.md #16）。
 */

const AUTOSAVE_DEBOUNCE_MS = 2000;
const AUTOSAVE_INTERVAL_MS = 30_000;

export interface ComposeController {
  intent: ComposeIntent | null;
  open: (kind: ComposeKind, messageId?: number) => void;
  close: () => void;
}

/** `?compose=` 的读写。撰写必须能覆盖在任何列表/阅读上下文之上，所以它是 query 不是路由。 */
export function useComposeIntent(): ComposeController {
  const location = useLocation();
  const navigate = useNavigate();

  const raw = new URLSearchParams(location.search).get('compose');
  const intent = useMemo(() => parseComposeParam(raw), [raw]);

  const open = useCallback(
    (kind: ComposeKind, messageId?: number) => {
      const params = new URLSearchParams(location.search);
      params.set('compose', formatComposeParam({ kind, messageId: messageId ?? null }));
      void navigate({ pathname: location.pathname, search: params.toString() });
    },
    [location.pathname, location.search, navigate],
  );

  const close = useCallback(() => {
    const params = new URLSearchParams(location.search);
    params.delete('compose');
    void navigate(
      { pathname: location.pathname, search: params.toString() },
      { replace: true },
    );
  }, [location.pathname, location.search, navigate]);

  return { intent, open, close };
}

export type SaveState = 'idle' | 'saving' | 'saved';

export interface ComposeState {
  draft: ComposeDraft;
  patch: (changes: Partial<ComposeDraft>) => void;
  setRecipients: (field: 'to' | 'cc' | 'bcc', addresses: EmailAddress[]) => void;
  /** 返回新建的草稿附件条目，调用方可以立刻在正文里插入内联标记。 */
  attach: (files: FileList | File[], options?: { inline?: boolean }) => DraftAttachment[];
  removeAttachment: (localId: string) => void;
  saveState: SaveState;
  savedAt: number | null;
  discard: () => void;
  toRequest: () => SendMessageRequest | null;
}

/**
 * 草稿状态。
 *
 * **原信必须在挂载前就绪**（调用方等 `useMessageDetail` 回来再渲染），
 * 这样初值能在 `useState` 的惰性初始化里一次算完 —— 用 effect 补算会先渲染一帧空表单，
 * 收件人框会肉眼可见地闪一下。
 */
export function useComposeDraft(
  intent: ComposeIntent,
  accounts: readonly Account[],
  defaultAccountId: number | null,
  source: Message | undefined,
): ComposeState {
  const storageKey = draftStorageKey(intent);
  const uploads = useRef(new Map<string, AbortController>());

  const [draft, setDraft] = useState<ComposeDraft>(() => {
    const account = pickAccount(accounts, source?.accountId ?? defaultAccountId);
    const base = source
      ? draftFromMessage(source, account, intent.kind)
      : emptyDraft(account?.id ?? defaultAccountId);
    const saved = readJson<PersistedDraft | null>(storageKey, null);
    return saved ? fromPersisted(base, saved) : base;
  });
  const [savedAt, setSavedAt] = useState<number | null>(
    () => readJson<PersistedDraft | null>(storageKey, null)?.savedAt ?? null,
  );
  const [savedSignature, setSavedSignature] = useState<string | null>(() => signatureOf(draft));

  // 「正在保存 / 草稿已存」是派生值，不在 effect 里同步 setState
  const signature = signatureOf(draft);
  const saveState: SaveState = !isDraftDirty(draft)
    ? 'idle'
    : signature === savedSignature
      ? 'saved'
      : 'saving';

  const patch = useCallback((changes: Partial<ComposeDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
  }, []);

  const setRecipients = useCallback((field: 'to' | 'cc' | 'bcc', addresses: EmailAddress[]) => {
    setDraft((current) => ({ ...current, [field]: addresses }));
  }, []);

  // 停止输入 2s 后存一次；另有 30s 的定时兜底（screens.md §5.1）
  useEffect(() => {
    if (saveState !== 'saving') return;
    const timer = window.setTimeout(() => {
      const persisted = toPersisted(draft);
      writeJson(storageKey, persisted);
      setSavedAt(persisted.savedAt);
      setSavedSignature(signature);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [saveState, draft, signature, storageKey]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDraft((current) => {
        if (isDraftDirty(current)) writeJson(storageKey, toPersisted(current));
        return current;
      });
    }, AUTOSAVE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [storageKey]);

  const attach = useCallback(
    (files: FileList | File[], options: { inline?: boolean } = {}): DraftAttachment[] => {
      const created: DraftAttachment[] = [];
      for (const file of Array.from(files)) {
        const localId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const controller = new AbortController();
        uploads.current.set(localId, controller);

        const entry: DraftAttachment = {
          localId,
          filename: file.name,
          contentType: file.type || null,
          size: file.size,
          sha256: null,
          progress: 0,
          error: null,
          contentId: options.inline === true ? `${localId}@firemail` : null,
        };
        created.push(entry);
        setDraft((current) => ({ ...current, attachments: [...current.attachments, entry] }));

        void uploadAttachment(file, {
          signal: controller.signal,
          onProgress: (percent) => updateAttachment(setDraft, localId, { progress: percent }),
        })
          .then((uploaded) => {
            updateAttachment(setDraft, localId, {
              sha256: uploaded.sha256,
              size: uploaded.size,
              progress: 100,
            });
          })
          .catch((error: unknown) => {
            updateAttachment(setDraft, localId, { error: humanizeApiError(error) });
          })
          .finally(() => uploads.current.delete(localId));
      }
      return created;
    },
    [],
  );

  const removeAttachment = useCallback((localId: string) => {
    uploads.current.get(localId)?.abort();
    uploads.current.delete(localId);
    setDraft((current) => ({
      ...current,
      attachments: current.attachments.filter((item) => item.localId !== localId),
    }));
  }, []);

  const discard = useCallback(() => {
    for (const controller of uploads.current.values()) controller.abort();
    uploads.current.clear();
    removeStorage(storageKey);
    setSavedAt(null);
    setSavedSignature(null);
  }, [storageKey]);

  const toRequest = useCallback((): SendMessageRequest | null => {
    if (draft.accountId === null || draft.to.length === 0) return null;
    return {
      accountId: draft.accountId,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      bodyText: draft.body,
      ...(draft.bodyHtml ? { bodyHtml: draft.bodyHtml } : {}),
      ...(draft.inReplyToMessageId === null ? {} : { inReplyToMessageId: draft.inReplyToMessageId }),
      attachmentIds: draft.forwardAttachmentIds,
      mode: draft.mode,
      attachments: draft.attachments
        .filter((item): item is DraftAttachment & { sha256: string } => item.sha256 !== null)
        .map((item) => ({
          sha256: item.sha256,
          filename: item.filename,
          contentType: item.contentType,
          contentId: item.contentId,
        })),
    };
  }, [draft]);

  return {
    draft,
    patch,
    setRecipients,
    attach,
    removeAttachment,
    saveState,
    savedAt,
    discard,
    toRequest,
  };
}

/** 草稿内容指纹：用来判断「改过之后还没存」。 */
function signatureOf(draft: ComposeDraft): string {
  return JSON.stringify(toPersisted(draft, 0));
}

function updateAttachment(
  setDraft: React.Dispatch<React.SetStateAction<ComposeDraft>>,
  localId: string,
  changes: Partial<DraftAttachment>,
): void {
  setDraft((current) => ({
    ...current,
    attachments: current.attachments.map((item) =>
      item.localId === localId ? { ...item, ...changes } : item,
    ),
  }));
}

/** 发件账号：优先原信所属账号，其次默认账号，最后第一个可用账号。 */
function pickAccount(accounts: readonly Account[], preferred: number | null): Account | null {
  const usable = accounts.filter((account) => account.status !== 'disabled');
  return (
    usable.find((account) => account.id === preferred) ??
    usable.find((account) => account.status === 'active') ??
    usable[0] ??
    null
  );
}
