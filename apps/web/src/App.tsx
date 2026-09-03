import { RouterProvider } from 'react-router';
import { AppProviders } from '@/providers/app-providers';
import { router } from '@/routes/router';

/**
 * RouterProvider 从 `react-router` 取，不从 `react-router/dom` 取：
 * 后者在 Node 条件下会解析成另一份模块实例，路由 context 对不上，
 * 路由元素里的 `useNavigate()` 会直接抛 “may be used only in the context of a <Router>”。
 * 我们没有用到 `react-router/dom` 才有的 `<Form>` / fetcher。
 */
export function App() {
  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
