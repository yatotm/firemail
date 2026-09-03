import { RadioGroup, SettingBlock, SettingRow, Switch } from '@/components/settings/controls';
import { FormSkeleton } from '@/components/common/skeletons';
import { useSettingsPatch, useUserSettings } from '@/hooks/accounts/use-user-settings';
import { DENSITIES, DENSITY_LABEL, useDensity } from '@/hooks/use-density';
import { THEME_LABEL, THEMES, useTheme } from '@/hooks/use-theme';

const THEME_OPTIONS = THEMES.map((theme) => ({ value: theme, label: THEME_LABEL[theme] }));
const DENSITY_OPTIONS = DENSITIES.map((density) => ({
  value: density,
  label: DENSITY_LABEL[density],
}));
const TIME_FORMAT_OPTIONS = [
  { value: '24h' as const, label: '24 小时（14:32）' },
  { value: '12h' as const, label: '12 小时（2:32 PM）' },
];

/**
 * 外观。主题与密度是纯本地偏好（localStorage），时间格式与线程折叠存服务端 ——
 * 换设备要保留的才上服务端（IA §8）。所有开关立即生效，没有保存按钮。
 */
export function AppearancePanel() {
  const { theme, setTheme } = useTheme();
  const { density, setDensity } = useDensity();
  const settings = useUserSettings();
  const { patch } = useSettingsPatch();

  return (
    <div className="divide-y">
      <SettingBlock title="主题" description="深浅色切换是瞬时的，不做渐变动画。">
        <RadioGroup name="主题" value={theme} options={THEME_OPTIONS} onChange={setTheme} />
      </SettingBlock>

      <SettingBlock title="列表密度" description="紧凑档一屏能多看 60% 的邮件，适合扫验证码。">
        <RadioGroup
          name="列表密度"
          value={density}
          options={DENSITY_OPTIONS}
          onChange={setDensity}
        />
      </SettingBlock>

      {settings.isPending ? (
        <div className="py-4">
          <FormSkeleton fields={2} />
        </div>
      ) : (
        <>
          <SettingBlock title="时间格式">
            <RadioGroup
              name="时间格式"
              value={settings.data?.timeFormat ?? '24h'}
              options={TIME_FORMAT_OPTIONS}
              onChange={(timeFormat) => patch({ timeFormat })}
            />
          </SettingBlock>

          <SettingRow
            title="线程折叠"
            description="把同一会话的邮件折叠成一条"
            control={
              <Switch
                checked={settings.data?.threadView ?? true}
                onCheckedChange={(threadView) => patch({ threadView })}
                label="把同一会话的邮件折叠成一条"
              />
            }
          />
        </>
      )}
    </div>
  );
}
