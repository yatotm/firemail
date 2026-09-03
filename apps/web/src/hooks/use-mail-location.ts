import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  DEFAULT_VIEW,
  mailPath,
  parseScope,
  parseView,
  type MailScope,
  type MailView,
} from '@/lib/nav';

export interface MailLocation {
  scope: MailScope;
  view: MailView;
  messageId: number | null;
  /** 当前是否在 /mail 路由下（在 /accounts、/settings 上仍然要能读到最近一次的 scope）。 */
  isMailRoute: boolean;
  /** 只改 scope，不动 view —— IA 的关键不变量。 */
  setScope: (scope: MailScope) => void;
  /** 只改 view，不动 scope。 */
  setView: (view: MailView) => void;
}

const MAIL_PATH = /^\/mail\/([^/]+)\/([^/]+)(?:\/(\d+))?/;

export function useMailLocation(): MailLocation {
  const location = useLocation();
  const navigate = useNavigate();

  const match = MAIL_PATH.exec(location.pathname);
  const rawScope = match?.[1];
  const rawView = match?.[2];
  const messageId = match?.[3] ? Number(match[3]) : null;

  const scope = useMemo(() => parseScope(rawScope), [rawScope]);
  const view = useMemo(() => parseView(rawView), [rawView]);

  const setScope = useCallback(
    (next: MailScope) => void navigate(mailPath(next, view)),
    [navigate, view],
  );

  const setView = useCallback(
    (next: MailView) => void navigate(mailPath(scope, next)),
    [navigate, scope],
  );

  return {
    scope,
    view: rawView ? view : DEFAULT_VIEW,
    messageId,
    isMailRoute: match !== null,
    setScope,
    setView,
  };
}
