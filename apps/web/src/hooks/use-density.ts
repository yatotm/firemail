import { createContext, use } from 'react';

/** 列表密度（tokens.md §9）。紧凑档是本产品扫 29 个账号找验证码的核心档位。 */
export const DENSITIES = ['compact', 'cozy', 'comfortable'] as const;
export type Density = (typeof DENSITIES)[number];

export const DENSITY_LABEL: Record<Density, string> = {
  compact: '紧凑',
  cozy: '适中',
  comfortable: '舒适',
};

export interface DensityContextValue {
  density: Density;
  setDensity: (density: Density) => void;
  /** `Shift+D` 循环：紧凑 → 适中 → 舒适。 */
  cycleDensity: () => void;
}

export const DensityContext = createContext<DensityContextValue | null>(null);

export function useDensity(): DensityContextValue {
  const value = use(DensityContext);
  if (!value) throw new Error('useDensity 必须在 DensityProvider 内使用');
  return value;
}

export function isDensity(value: unknown): value is Density {
  return typeof value === 'string' && (DENSITIES as readonly string[]).includes(value);
}

export function nextDensity(current: Density): Density {
  const index = DENSITIES.indexOf(current);
  return DENSITIES[(index + 1) % DENSITIES.length] ?? 'cozy';
}
