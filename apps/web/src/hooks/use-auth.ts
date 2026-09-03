import type { LoginRequest, User } from '@firemail/shared';
import { createContext, use } from 'react';

export interface AuthContextValue {
  user: User | null;
  /** 首次拉会话还没回来 —— 这时候不能判定「未登录」，否则会闪一下登录页。 */
  isLoading: boolean;
  login: (credentials: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = use(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return value;
}
