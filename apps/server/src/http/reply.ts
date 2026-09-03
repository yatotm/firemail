import type { ApiSuccess, PageMeta, Paginated } from '@firemail/shared';

/** 成功信封。所有 2xx JSON 响应都必须过这里，前端只解一种形状。 */
export function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

export interface PageInput {
  limit: number;
  offset: number;
}

export function pageMeta(returned: number, total: number | null, page: PageInput): PageMeta {
  return {
    total,
    limit: page.limit,
    offset: page.offset,
    hasMore: total === null ? returned >= page.limit : page.offset + returned < total,
    nextCursor: null,
  };
}

export function paginate<T>(items: T[], total: number | null, page: PageInput): Paginated<T> {
  return { items, page: pageMeta(items.length, total, page) };
}

/** 内存里的整表分页。只用于本来就很小的集合（用户、会话、账号）。 */
export function paginateArray<T>(all: T[], page: PageInput): Paginated<T> {
  return paginate(all.slice(page.offset, page.offset + page.limit), all.length, page);
}
