import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DensityContext,
  isDensity,
  nextDensity,
  type Density,
} from '@/hooks/use-density';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';

function initialDensity(): Density {
  const stored = readStorage(StorageKey.density);
  return isDensity(stored) ? stored : 'cozy';
}

/** 密度写在 `<html data-density>` 上，行高由 CSS 变量 `--fm-row-height` 决定。 */
export function DensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensityState] = useState<Density>(initialDensity);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  const setDensity = useCallback((value: Density) => {
    writeStorage(StorageKey.density, value);
    setDensityState(value);
  }, []);

  const cycleDensity = useCallback(() => {
    setDensityState((current) => {
      const next = nextDensity(current);
      writeStorage(StorageKey.density, next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ density, setDensity, cycleDensity }),
    [density, setDensity, cycleDensity],
  );

  return <DensityContext value={value}>{children}</DensityContext>;
}
