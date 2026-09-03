import { userSettingsSchema } from '@firemail/shared';
import { XIcon } from 'lucide-react';
import { useState } from 'react';
import { FormSkeleton } from '@/components/common/skeletons';
import { RadioGroup, SettingBlock, SettingRow, Switch } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSettingsPatch, useUserSettings } from '@/hooks/accounts/use-user-settings';

/** 与服务端同一份域名校验，报错文案也一致。 */
const domainSchema = userSettingsSchema.shape.trustedSenderDomains.removeDefault().element;

const REMOTE_IMAGE_OPTIONS = [
  { value: 'always' as const, label: '总是显示', description: '任何发件人的远程图片都直接加载' },
  { value: 'ask' as const, label: '询问（默认）', description: '先拦截，逐封决定是否显示' },
  { value: 'never' as const, label: '从不显示', description: '完全不加载远程图片' },
];

const DARK_EMAIL_OPTIONS = [
  { value: 'paper' as const, label: '白纸（推荐）', description: '深色界面下邮件正文仍是白底，永不失真' },
  { value: 'smart' as const, label: '智能', description: '简单邮件用暗色，复杂排版保持白纸' },
  { value: 'invert' as const, label: '强制反色', description: '可能损坏图片与品牌色' },
];

/** 阅读设置。远程图片策略与信任域名有安全含义，所以存服务端而不是浏览器本地。 */
export function ReadingPanel() {
  const settings = useUserSettings();
  const { patch } = useSettingsPatch();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (settings.isPending) {
    return (
      <div className="py-4">
        <FormSkeleton fields={3} />
      </div>
    );
  }

  const data = settings.data;
  const domains = data?.trustedSenderDomains ?? [];

  const addDomain = () => {
    const parsed = domainSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '不是合法的域名');
      return;
    }
    if (domains.includes(parsed.data)) {
      setError('这个域名已经在列表里了');
      return;
    }
    setError(null);
    setDraft('');
    patch({ trustedSenderDomains: [...domains, parsed.data] });
  };

  return (
    <div className="divide-y">
      <SettingBlock title="远程图片" description="远程图片会把「你读了这封信」告诉发件人。">
        <RadioGroup
          name="远程图片"
          value={data?.remoteImages ?? 'ask'}
          options={REMOTE_IMAGE_OPTIONS}
          onChange={(remoteImages) => patch({ remoteImages })}
        />
      </SettingBlock>

      <SettingBlock
        title="信任的发件人域名"
        description="来自这些域名的邮件会直接加载远程图片。"
      >
        <ul className="flex flex-wrap gap-1.5">
          {domains.map((domain) => (
            <li
              key={domain}
              className="inline-flex items-center gap-1 rounded-xs bg-muted px-1.5 py-0.5 text-xs"
            >
              <span className="font-mono">{domain}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`移除 ${domain}`}
                onClick={() =>
                  patch({ trustedSenderDomains: domains.filter((item) => item !== domain) })
                }
              >
                <XIcon aria-hidden />
              </Button>
            </li>
          ))}
          {domains.length === 0 ? (
            <li className="text-xs text-muted-foreground">还没有信任任何域名</li>
          ) : null}
        </ul>

        <div className="flex items-end gap-2 pt-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="trusted-domain" className="text-xs">
              添加域名
            </Label>
            <Input
              id="trusted-domain"
              value={draft}
              placeholder="github.com"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'trusted-domain-error' : undefined}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addDomain();
                }
              }}
            />
          </div>
          <Button variant="outline" onClick={addDomain}>
            添加
          </Button>
        </div>
        {error ? (
          <p id="trusted-domain-error" className="text-xs text-destructive" aria-live="assertive">
            {error}
          </p>
        ) : null}
      </SettingBlock>

      <SettingBlock title="深色模式下的邮件正文">
        <RadioGroup
          name="邮件暗色策略"
          value={data?.darkEmailPolicy ?? 'paper'}
          options={DARK_EMAIL_OPTIONS}
          onChange={(darkEmailPolicy) => patch({ darkEmailPolicy })}
        />
      </SettingBlock>

      <SettingRow
        title="自动折叠引用与签名"
        description="长回复链只显示最新一段"
        control={
          <Switch
            checked={data?.collapseQuotes ?? true}
            onCheckedChange={(collapseQuotes) => patch({ collapseQuotes })}
            label="自动折叠引用与签名"
          />
        }
      />
    </div>
  );
}
