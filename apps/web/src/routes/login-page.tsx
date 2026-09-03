import { loginRequestSchema } from '@firemail/shared';
import { EyeIcon, EyeOffIcon, FlameIcon, LoaderCircleIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { humanizeApiError, isApiError } from '@/lib/api';
import { routePaths } from '@/lib/nav';

const APP_VERSION = '2.0.0';
const RATE_LIMIT_SECONDS = 60;

interface LocationState {
  from?: string;
}

/** @types/react 已把 FormEvent 标记为不存在，直接从 <form> 的 props 取处理函数类型。 */
type SubmitHandler = NonNullable<ComponentProps<'form'>['onSubmit']>;

/**
 * 唯一免鉴权的屏幕。视觉语言与外壳完全一致（同一套令牌、同样的圆角与字号），
 * 不做一个「登录页专属」的样式体系。
 */
export function LoginPage() {
  const { user, isLoading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  if (!isLoading && user) {
    const from = (location.state as LocationState | null)?.from;
    return <Navigate to={from && from !== routePaths.login ? from : '/'} replace />;
  }

  const submit = async () => {
    const parsed = loginRequestSchema.safeParse({ username, password });
    if (!parsed.success) {
      // 不区分「用户不存在」和「密码错误」，这里也只说规则不说是哪一项错
      setError('请输入有效的用户名和密码（用户名 3–64 位，密码至少 8 位）');
      passwordRef.current?.focus();
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await login(parsed.data);
      const from = (location.state as LocationState | null)?.from;
      await navigate(from && from !== routePaths.login ? from : '/', { replace: true });
    } catch (cause) {
      if (isApiError(cause) && cause.status === 429) {
        setCooldown(RATE_LIMIT_SECONDS);
        setError(`尝试过于频繁，请在 ${RATE_LIMIT_SECONDS} 秒后重试`);
      } else if (isApiError(cause) && cause.status === 401) {
        setError('用户名或密码错误');
      } else {
        setError(humanizeApiError(cause));
      }
      setPassword('');
      passwordRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit: SubmitHandler = (event) => {
    event.preventDefault();
    if (submitting || cooldown > 0) return;
    void submit();
  };

  return (
    <div className="flex min-h-full items-start justify-center bg-background px-4 pt-[15vh] md:items-center md:pt-0">
      <div className="w-full max-w-[360px]">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <FlameIcon className="size-8 text-primary" aria-hidden />
          <h1 className="text-3xl font-semibold">FireMail</h1>
          <p className="text-sm text-muted-foreground">多账号邮件聚合</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* 容器始终存在，只有内容变化，屏幕阅读器才会播报（accessibility.md §2.4） */}
          <div aria-live="assertive">
            {error ? (
              <p
                role="alert"
                className="rounded-sm bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground"
              >
                {error}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="username" className="text-xs">
              用户名
            </Label>
            <Input
              id="username"
              name="username"
              autoComplete="username"
              // eslint-disable-next-line jsx-a11y/no-autofocus -- 登录页只有这一个表单，聚焦第一个字段是预期行为
              autoFocus
              required
              readOnly={submitting}
              aria-busy={submitting}
              aria-invalid={error !== null}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="h-10"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password" className="text-xs">
              密码
            </Label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                ref={passwordRef}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                readOnly={submitting}
                aria-busy={submitting}
                aria-invalid={error !== null}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="h-10 pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute top-1 right-1"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
              </Button>
            </div>
          </div>

          <Button type="submit" className="h-10 w-full" disabled={submitting || cooldown > 0}>
            {submitting ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : null}
            {submitting ? '登录中…' : cooldown > 0 ? `请等待 ${cooldown} 秒` : '登录'}
          </Button>
        </form>

        <p className="mt-8 text-center text-2xs text-muted-foreground">
          FireMail v{APP_VERSION} · 自托管
        </p>
      </div>
    </div>
  );
}
