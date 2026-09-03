import type { Account } from '@firemail/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportCredentialsDialog } from '@/components/accounts/export-credentials-dialog';

/**
 * 全量导出的前端契约：先讲后果、必须显式确认、文件直接落盘（**不渲染进页面**），
 * 以及「有账号没进这个文件」必须说出来 —— 备份最坏的失败方式是让人以为它是完整的。
 */

const FILE_BODY = 'a@outlook.com----pw----cid----rt\n';

function account(id: number, overrides: Partial<Account> = {}): Account {
  return {
    id,
    userId: 1,
    email: `a${String(id)}@outlook.com`,
    displayName: null,
    provider: 'outlook',
    authType: 'oauth2',
    imapHost: null,
    imapPort: null,
    imapSecure: true,
    smtpHost: null,
    smtpPort: null,
    smtpSecure: true,
    smtpStatus: 'unknown',
    smtpError: null,
    smtpCheckedAt: null,
    hasPassword: true,
    hasOAuthToken: true,
    oauthClientId: 'client-1',
    oauthTokenExpiresAt: null,
    oauthScope: null,
    status: 'active',
    lastError: null,
    lastErrorAt: null,
    syncEnabled: true,
    syncIntervalSeconds: 300,
    lastSyncedAt: null,
    unreadCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function fileResponse(exported: number, skipped: number): Response {
  return new Response(FILE_BODY, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="firemail-credentials-2026-09-04T02-30-00Z.txt"',
      'x-firemail-export-count': String(exported),
      'x-firemail-export-skipped': String(skipped),
    },
  });
}

const fetchMock = vi.fn<typeof fetch>();
const createObjectURL = vi.fn(() => 'blob:mock');
const revokeObjectURL = vi.fn();

function renderDialog(accounts: Account[]) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ExportCredentialsDialog open onOpenChange={() => undefined} accounts={accounts} />
    </QueryClientProvider>,
  );
}

const exportButton = () => screen.getByRole('button', { name: /导出并下载/ });

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(fileResponse(1, 0));
  vi.stubGlobal('fetch', fetchMock);

  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
  // jsdom 不实现导航；下载用的 <a download> 点击会走到这里
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('导出凭据对话框', () => {
  it('把后果讲清楚：明文、保管方式、泄漏后果', () => {
    renderDialog([account(1)]);

    expect(screen.getByText(/文件里是明文凭据/)).toBeInTheDocument();
    expect(screen.getByText(/等于拿到这些邮箱的完全访问权/)).toBeInTheDocument();
    expect(screen.getByText(/离线且加密的地方/)).toBeInTheDocument();
  });

  it('没勾确认就不能导出，也不会发请求', () => {
    renderDialog([account(1)]);

    expect(exportButton()).toBeDisabled();
    fireEvent.click(exportButton());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('勾了确认才导出，并且带 confirm:true', async () => {
    renderDialog([account(1), account(2)]);

    fireEvent.click(screen.getByLabelText(/我明白这个文件包含明文凭据/));
    expect(exportButton()).toBeEnabled();
    fireEvent.click(exportButton());

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/credentials/export',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ confirm: true }) }),
      );
    });
  });

  it('结果是文件下载，正文一个字都不渲染进页面', async () => {
    renderDialog([account(1)]);

    fireEvent.click(screen.getByLabelText(/我明白这个文件包含明文凭据/));
    fireEvent.click(exportButton());

    await screen.findByText(/firemail-credentials-2026-09-04T02-30-00Z\.txt/);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(FILE_BODY.trim());
  });

  it('点之前就告诉用户哪些账号进不了这个文件', () => {
    renderDialog([
      account(1),
      account(2, { authType: 'password', provider: 'qq', hasOAuthToken: false, oauthClientId: null }),
    ]);

    expect(screen.getByText(/将导出/)).toHaveTextContent('将导出 1 个账号');
    expect(screen.getByText(/有 1 个账号无法用四字段格式表达/)).toBeInTheDocument();
    expect(screen.getByText('a2@outlook.com')).toBeInTheDocument();
  });

  it('服务端说有账号没进文件时，结果里明说这份备份不完整', async () => {
    fetchMock.mockResolvedValue(fileResponse(3, 2));
    renderDialog([account(1)]);

    fireEvent.click(screen.getByLabelText(/我明白这个文件包含明文凭据/));
    fireEvent.click(exportButton());

    expect(await screen.findByText(/并不完整/)).toBeInTheDocument();
    expect(screen.getByText(/有 2 个账号没能写进文件/)).toBeInTheDocument();
  });

  it('失败时显示服务端给的原因', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: { code: 'forbidden', message: '该操作仅限管理员' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderDialog([account(1)]);

    fireEvent.click(screen.getByLabelText(/我明白这个文件包含明文凭据/));
    fireEvent.click(exportButton());

    expect(await screen.findByText('该操作仅限管理员')).toBeInTheDocument();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
