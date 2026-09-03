import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createQueryClient } from '@/lib/query-client';
import { CommandProvider } from '@/providers/command-provider';
import { DensityProvider } from '@/providers/density-provider';
import { LiveRegionProvider } from '@/providers/live-region-provider';
import { ShortcutProvider } from '@/providers/shortcut-provider';
import { ThemeProvider } from '@/providers/theme-provider';

/**
 * 路由**之外**的 provider：主题、密度、查询客户端、键位、命令面板、live region。
 * 需要 router 上下文的（AuthProvider / ServerEventsProvider）在路由内部挂。
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return (
    <ThemeProvider>
      <DensityProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={300}>
            <ShortcutProvider>
              <CommandProvider>
                <LiveRegionProvider>
                  {children}
                  <Toaster position="bottom-right" closeButton />
                </LiveRegionProvider>
              </CommandProvider>
            </ShortcutProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </DensityProvider>
    </ThemeProvider>
  );
}
