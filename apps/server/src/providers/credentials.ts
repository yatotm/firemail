import type { OAuthTokenService } from '../auth/oauth/tokenService.ts';
import type { SecretBox } from '../crypto/secretBox.ts';
import { ProviderError, type AccountRow, type CredentialResolver, type MailAuth } from './types.ts';

/**
 * 把账号行里的密文变成一份可用的认证材料。
 *
 * OAuth 分支只经由 OAuthTokenService，因此拿到的 access token 必然已经过
 * 「刷新 → 轮换落库 → 才返回」这条路径，没有旁路可走。
 */
export class AccountCredentialResolver implements CredentialResolver {
  readonly #box: SecretBox;
  readonly #tokens: OAuthTokenService;

  constructor(deps: { box: SecretBox; tokens: OAuthTokenService }) {
    this.#box = deps.box;
    this.#tokens = deps.tokens;
  }

  async resolve(account: AccountRow): Promise<MailAuth> {
    if (account.authType === 'oauth2') {
      const grant = await this.#tokens.getAccessToken(account.id);
      return { kind: 'oauth2', user: account.email, accessToken: grant.accessToken };
    }

    if (!account.passwordEnc) {
      throw new ProviderError(`账号 ${account.email} 未配置密码`);
    }
    return { kind: 'password', user: account.email, pass: this.#box.decrypt(account.passwordEnc) };
  }
}
