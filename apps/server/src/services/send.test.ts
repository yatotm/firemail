import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Transporter } from 'nodemailer';
import {
  authed,
  cleanupScratch,
  error,
  login,
  makeApp,
  seedAccount,
  seedUser,
} from '../http/__testkit__/index.ts';
import type { SyncLogger } from '../sync/types.ts';
import { SendService, SendServiceError, type TransportFactory } from './send.ts';

/**
 * 停机排空。
 *
 * 发信本身的端到端测试在 routes/send.test.ts；这里只回答一个问题：
 * SIGTERM 到了，已经受理（202）但 SMTP 会话还没跑完的那封信会怎么样。
 */

after(cleanupScratch);

const REQUEST = {
  accountId: 0,
  to: [{ name: null, address: 'her@example.com' }],
  cc: [],
  bcc: [],
  subject: '停机测试',
  bodyText: '正文',
  attachmentIds: [],
  mode: 'new' as const,
  attachments: [],
};

/** 手动控制 SMTP 什么时候返回：排空要等的正是这段时间。 */
function pausedSmtp(): { factory: TransportFactory; release: () => void } {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const factory: TransportFactory = async () =>
    ({
      async sendMail(mail: { envelope: { from: string; to: string[] } }) {
        await gate;
        return { envelope: mail.envelope, accepted: mail.envelope.to, rejected: [] };
      },
      close() {},
    }) as unknown as Transporter;

  return { factory, release: () => release() };
}

interface LogLine {
  message: string;
  meta: Record<string, unknown> | undefined;
}

function captureErrors(): { lines: LogLine[]; log: SyncLogger } {
  const lines: LogLine[] = [];
  const push = (message: string, meta?: Record<string, unknown>): void => {
    lines.push({ message, meta });
  };
  return {
    lines,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: push },
  };
}

async function fixture(transport: TransportFactory, log?: SyncLogger) {
  const t = await makeApp({ transport });
  const user = seedUser(t.db);
  const accountId = seedAccount(t, user.id, { email: 'me@outlook.com' });

  const send = new SendService({
    db: t.db,
    accounts: t.ctx.accounts,
    attachmentStore: t.ctx.attachmentStore,
    transport,
    ...(log ? { log } : {}),
  });

  return {
    t,
    user,
    send,
    submit: () => send.submit(user.id, { ...REQUEST, accountId }),
  };
}

/** 让已经排队的微任务跑完，用来断言「此刻还没结束」。 */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('排空会等在飞的发信跑完，SMTP 收尾后才返回', async () => {
  const smtp = pausedSmtp();
  const f = await fixture(smtp.factory);
  try {
    const job = f.submit();
    assert.equal(f.send.get(f.user.id, job.id)?.status, 'sending');

    f.send.stopAccepting();
    let done = false;
    const draining = f.send.drain(5_000).then((ids) => {
      done = true;
      return ids;
    });

    await tick();
    assert.equal(done, false, 'SMTP 还没回来，排空不能提前返回');

    smtp.release();
    assert.deepEqual(await draining, [], '全部收尾后不该有遗留任务');
    assert.equal(f.send.get(f.user.id, job.id)?.status, 'sent', '停机没有吞掉这封信');
  } finally {
    smtp.release();
    await f.t.close();
  }
});

test('超过期限就放弃等待，并记下还在跑的任务', async () => {
  const smtp = pausedSmtp();
  const capture = captureErrors();
  const f = await fixture(smtp.factory, capture.log);
  const job = f.submit();
  try {
    f.send.stopAccepting();

    const pending = await f.send.drain(50);
    assert.deepEqual(pending, [job.id], '超时要把没跑完的任务交回去');

    const line = capture.lines.at(-1);
    assert.ok(line, '超时必须留下日志，否则丢了哪封信无从查起');
    assert.match(line.message, /未在停机期限内结束/);
    assert.deepEqual(line.meta?.['jobIds'], [job.id]);
    assert.equal(line.meta?.['timeoutMs'], 50);
  } finally {
    // 放行之后等这封信真的结束，否则关库会和后台任务撞上
    smtp.release();
    await f.send.wait(job.id);
    await f.t.close();
  }
});

test('没有在飞的任务时排空立刻返回', async () => {
  const smtp = pausedSmtp();
  const f = await fixture(smtp.factory);
  try {
    assert.deepEqual(await f.send.drain(30_000), []);
  } finally {
    await f.t.close();
  }
});

test('停机后不再受理新的发信', async () => {
  const smtp = pausedSmtp();
  const f = await fixture(smtp.factory);
  try {
    f.send.stopAccepting();
    assert.throws(
      () => f.submit(),
      (err: unknown) =>
        err instanceof SendServiceError && err.code === 'upstream_error' && /停机/.test(err.message),
    );
  } finally {
    await f.t.close();
  }
});

test('停机后 POST /api/messages/send 回错误信封而不是 202', async () => {
  const smtp = pausedSmtp();
  const t = await makeApp({ transport: smtp.factory });
  try {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const accountId = seedAccount(t, user.id, { email: 'me@outlook.com' });

    t.ctx.send.stopAccepting();
    const response = await authed(t, session, {
      method: 'POST',
      url: '/api/messages/send',
      payload: { ...REQUEST, accountId },
    });

    assert.equal(response.statusCode, 502);
    assert.equal(error(response).code, 'upstream_error');
    assert.match(error(response).message, /停机/);
  } finally {
    await t.close();
  }
});
