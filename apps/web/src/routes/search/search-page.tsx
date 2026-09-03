import type { Account, MessageSummary } from '@firemail/shared';
import { SearchIcon, SearchXIcon, XIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorBanner } from '@/components/common/error-state';
import { ListSkeleton } from '@/components/common/skeletons';
import { ComposeWindow } from '@/components/compose/compose-window';
import { MessageList } from '@/components/mail/message-list';
import { SearchFiltersPanel } from '@/components/mail/search-filters';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAccounts } from '@/hooks/use-accounts';
import { useAnnouncer } from '@/hooks/use-announcer';
import { useDensity } from '@/hooks/use-density';
import { useIsMobileLayout } from '@/hooks/use-media-query';
import { useShortcuts, useShortcutScope } from '@/hooks/use-shortcuts';
import { useComposeIntent } from '@/hooks/mail/use-compose';
import { useFolders } from '@/hooks/mail/use-folders';
import { useMailSelection } from '@/hooks/mail/use-mail-selection';
import { useSearch, SEARCH_MODE_LABEL } from '@/hooks/mail/use-search';
import { effectiveDensity } from '@/lib/mail/density';
import { extractOtp, findTermRanges } from '@/lib/mail/otp';
import { buildRows } from '@/lib/mail/rows';
import {
  applyTokens,
  highlightTerms,
  parseSearchInput,
  searchFiltersFromParams,
  searchFiltersToParams,
  type SearchFilters,
} from '@/lib/mail/search-query';
import { ALL_SCOPE, mailPath } from '@/lib/nav';
import { cn } from '@/lib/utils';

const SYNTAX_HINTS = [
  'from:github.com  —— 按发件人筛选',
  'is:unread  —— 只看未读',
  'has:attachment  —— 只看带附件的',
  'after:2026-08-01  —— 指定时间范围',
];

/**
 * 搜索（screens.md §6）。
 *
 * 是独立页面而不是弹层：结果要能分享收藏、可能很大需要完整分页与筛选、
 * 从结果打开邮件后按返回要能回到结果。
 */
export function SearchPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { density: preference } = useDensity();
  const isMobile = useIsMobileLayout();
  const density = effectiveDensity(preference, isMobile);
  const { announce } = useAnnouncer();

  const submittedQuery = searchParams.get('q') ?? '';
  const [input, setInput] = useState(submittedQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const compose = useComposeIntent();

  const accountsQuery = useAccounts();
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const accountsById = useMemo(
    () => new Map<number, Account>(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const foldersQuery = useFolders();

  const urlFilters = useMemo(() => searchFiltersFromParams(searchParams), [searchParams]);
  const parsed = useMemo(() => parseSearchInput(submittedQuery), [submittedQuery]);

  // 已识别的操作符叠加在筛选面板之上；`account:` 要先按邮箱查到 id
  const filters = useMemo<SearchFilters>(() => {
    const merged = applyTokens(urlFilters, parsed);
    const accountToken = parsed.tokens.find((token) => token.kind === 'account');
    if (!accountToken) return merged;
    const matched = accounts.find((account) =>
      account.email.toLowerCase().includes(accountToken.value.toLowerCase()),
    );
    return matched ? { ...merged, accountId: matched.id } : merged;
  }, [urlFilters, parsed, accounts]);

  // 未识别的操作符不静默丢掉：它们留在 parsed.text 里当关键词搜，并在界面上说明
  const result = useSearch(parsed.text, filters);
  const { messages: allMessages, total, mode } = result;

  // 服务端没有验证码检索，这一项只在已加载的结果里筛，UI 已注明
  const messages = useMemo(
    () =>
      filters.hasCode === true
        ? allMessages.filter((message) => extractOtp(message.subject, message.snippet) !== null)
        : allMessages,
    [allMessages, filters.hasCode],
  );

  const selection = useMailSelection(messages, `search:${submittedQuery}`);
  const rows = useMemo(
    () => buildRows(messages, { grouped: filters.sort === 'receivedAt' }),
    [messages, filters.sort],
  );

  const terms = useMemo(() => highlightTerms(parsed), [parsed]);
  const highlightsFor = useCallback(
    (message: MessageSummary) => ({
      subject: findTermRanges(message.subject ?? '', terms),
      snippet: findTermRanges(message.snippet ?? '', terms),
    }),
    [terms],
  );

  const contextLabelFor = useCallback(
    (message: MessageSummary) => {
      const account = accountsById.get(message.accountId)?.email ?? '未知账号';
      const folder = foldersQuery.data?.find((item) => item.id === message.folderId)?.name ?? '';
      return folder ? `${account} · ${folder}` : account;
    },
    [accountsById, foldersQuery.data],
  );

  const submit = useCallback(
    (next: string, nextFilters: SearchFilters = filters) => {
      setSearchParams(searchFiltersToParams(next, nextFilters));
    },
    [filters, setSearchParams],
  );

  useShortcutScope('search');
  useShortcuts([
    { keys: '/', label: '聚焦搜索框', group: '搜索', scope: 'search', run: () => inputRef.current?.focus() },
    {
      keys: 'Escape',
      label: '清空搜索',
      group: '搜索',
      scope: 'search',
      allowInInput: true,
      run: () => {
        if (input !== '') {
          setInput('');
          return;
        }
        inputRef.current?.blur();
        listRef.current?.focus();
      },
    },
    { keys: 'c', label: '写新邮件', group: '撰写', scope: 'search', run: () => compose.open('new') },
  ]);

  const announced = useRef(-1);
  useEffect(() => {
    if (result.query.isPending || total === announced.current) return;
    announced.current = total ?? messages.length;
    if (submittedQuery) announce(`找到 ${total ?? messages.length} 封邮件`);
  }, [total, messages.length, result.query.isPending, submittedQuery, announce]);

  const hasQuery = submittedQuery.trim() !== '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b px-4 py-3">
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            submit(input);
          }}
          className="focus-ring-within flex h-10 items-center gap-2 rounded-md border border-input px-3"
        >
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            variant="bare"
            ref={inputRef}
            type="search"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={`搜索全部 ${accounts.length} 个账号`}
            aria-label="搜索邮件"
            className="flex-1 text-sm"
          />
          {input ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="清空"
              onClick={() => setInput('')}
            >
              <XIcon aria-hidden />
            </Button>
          ) : null}
          <Button type="submit" size="sm">
            搜索
          </Button>
        </form>

        {parsed.tokens.length > 0 || parsed.unknown.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {parsed.tokens.map((token) => (
              <span
                key={token.raw}
                className="inline-flex h-6 items-center gap-1 rounded-full bg-accent px-2 text-2xs text-accent-foreground"
              >
                {token.label}
                <button
                  type="button"
                  aria-label={`移除 ${token.raw}`}
                  onClick={() => submit(submittedQuery.replace(token.raw, '').trim())}
                >
                  <XIcon className="size-3" aria-hidden />
                </button>
              </span>
            ))}
            {parsed.unknown.map((raw) => (
              <span
                key={raw}
                className="inline-flex h-6 items-center rounded-full bg-warning-subtle px-2 text-2xs text-warning-subtle-foreground"
              >
                未识别：{raw}，已作为关键词搜索
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1">
        <SearchFiltersPanel
          filters={filters}
          onChange={(next) => submit(submittedQuery, next)}
          accounts={accounts}
          folders={foldersQuery.data ?? []}
        />

        <section aria-label="搜索结果" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-2xs text-muted-foreground">
            <span aria-live="polite" className="flex-1">
              {hasQuery && !result.query.isPending
                ? `找到 ${total ?? messages.length} 封 · 用时 ${result.elapsedMs}ms${mode ? ` · ${SEARCH_MODE_LABEL[mode]}` : ''}`
                : ''}
            </span>
            <button
              type="button"
              onClick={() =>
                submit(submittedQuery, {
                  ...filters,
                  sort: filters.sort === 'relevance' ? 'receivedAt' : 'relevance',
                })
              }
              className={cn('rounded-sm px-1.5 py-0.5 hover:bg-accent/40')}
            >
              {filters.sort === 'relevance' ? '相关度' : '时间'}
            </button>
          </div>

          {!hasQuery ? (
            <EmptyState
              icon={SearchIcon}
              title={`搜索全部 ${accounts.length} 个账号`}
              description={SYNTAX_HINTS.join('　')}
            />
          ) : result.query.isPending ? (
            <div aria-busy className="min-h-0 flex-1 overflow-hidden">
              <ListSkeleton rows={8} />
            </div>
          ) : result.query.isError ? (
            <div className="p-3">
              <ErrorBanner
                title="搜索失败"
                error={result.query.error}
                onRetry={() => void result.query.refetch()}
                className="rounded-md"
              />
            </div>
          ) : messages.length === 0 ? (
            <EmptyState
              icon={SearchXIcon}
              title={`没有找到「${submittedQuery}」`}
              description="试试减少筛选条件，或换一个关键词"
              actions={
                <Button variant="default" size="sm" onClick={() => submit(submittedQuery, { sort: filters.sort })}>
                  清除筛选后重试
                </Button>
              }
            />
          ) : (
            <MessageList
              rows={rows}
              messages={messages}
              accountsById={accountsById}
              density={density}
              activeId={null}
              selected={selection.selected}
              selectionMode={false}
              label={`搜索结果：${submittedQuery}`}
              total={total}
              hasMore={result.query.hasNextPage}
              loadingMore={result.query.isFetchingNextPage}
              busy={result.query.isFetching}
              highlightsFor={highlightsFor}
              contextLabelFor={contextLabelFor}
              containerRef={listRef}
              onOpen={(message) => void navigate(mailPath(ALL_SCOPE, 'inbox', message.id))}
              onToggleCheck={(message) => selection.toggle(message.id)}
              onLoadMore={() => void result.query.fetchNextPage()}
            />
          )}
        </section>
      </div>

      {compose.intent ? (
        <ComposeWindow
          intent={compose.intent}
          accounts={accounts}
          defaultAccountId={null}
          onClose={compose.close}
        />
      ) : null}
    </div>
  );
}
