import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROVIDER_AUTH_TYPES,
  PROVIDER_DEFAULTS,
  applyProviderDefaults,
  supportsAuthType,
} from './defaults.ts';

/** 服务商默认参数只有一张表，账号创建、连接、测试连通性全部读它。 */

test('Outlook 默认值与生产实测一致', () => {
  assert.deepEqual(PROVIDER_DEFAULTS.outlook, {
    imapHost: 'outlook.live.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp-mail.outlook.com',
    smtpPort: 587,
    // 587 是 STARTTLS：建连时是明文，升级后才是 TLS
    smtpSecure: false,
  });
});

test('四家服务商都有完整的默认值；自定义 IMAP 只给端口不给主机', () => {
  for (const [id, d] of Object.entries(PROVIDER_DEFAULTS)) {
    assert.ok(d.imapPort > 0 && d.smtpPort > 0, `${id} 端口缺失`);
    if (id === 'imap') {
      assert.equal(d.imapHost, null);
      assert.equal(d.smtpHost, null);
    } else {
      assert.ok(d.imapHost && d.smtpHost, `${id} 缺少默认服务器`);
    }
  }
});

test('直连 TLS 端口必须 secure=true，STARTTLS 端口必须 secure=false', () => {
  for (const [id, d] of Object.entries(PROVIDER_DEFAULTS)) {
    assert.equal(d.imapSecure, d.imapPort === 993, `${id} IMAP secure 与端口不匹配`);
    assert.equal(d.smtpSecure, d.smtpPort === 465, `${id} SMTP secure 与端口不匹配`);
  }
});

test('认证方式：Outlook 只走 OAuth，其余只走密码（应用专用密码/授权码）', () => {
  assert.deepEqual(PROVIDER_AUTH_TYPES.outlook, ['oauth2']);
  assert.deepEqual(PROVIDER_AUTH_TYPES.gmail, ['password']);
  assert.deepEqual(PROVIDER_AUTH_TYPES.qq, ['password']);
  assert.deepEqual(PROVIDER_AUTH_TYPES.imap, ['password']);

  assert.equal(supportsAuthType('outlook', 'oauth2'), true);
  assert.equal(supportsAuthType('outlook', 'password'), false);
  assert.equal(supportsAuthType('gmail', 'oauth2'), false, 'gmail 不做 OAuth 流程');
  assert.equal(supportsAuthType('qq', 'password'), true);
});

test('用户没填的字段用默认值补齐', () => {
  assert.deepEqual(applyProviderDefaults('qq', {}), {
    imapHost: 'imap.qq.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpSecure: true,
  });
});

test('用户填了的字段原样保留，包括 secure=false 这种 falsy 值', () => {
  const result = applyProviderDefaults('gmail', {
    imapHost: 'imap.example.com',
    imapPort: 1993,
    imapSecure: false,
    smtpSecure: true,
  });

  assert.equal(result.imapHost, 'imap.example.com');
  assert.equal(result.imapPort, 1993);
  assert.equal(result.imapSecure, false, 'false 不能被默认值 true 顶掉');
  assert.equal(result.smtpSecure, true);
  assert.equal(result.smtpHost, 'smtp.gmail.com', '没填的仍走默认');
});

test('显式 null 视为未填，走默认值', () => {
  const result = applyProviderDefaults('outlook', { imapHost: null, imapPort: null });
  assert.equal(result.imapHost, 'outlook.live.com');
  assert.equal(result.imapPort, 993);
});
