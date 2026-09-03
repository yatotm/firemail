import {
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import type { CSSProperties } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

import { useTheme } from "@/hooks/use-theme"

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme()

  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <LoaderCircleIcon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--success-subtle)",
          "--success-text": "var(--success-subtle-foreground)",
          "--warning-bg": "var(--warning-subtle)",
          "--warning-text": "var(--warning-subtle-foreground)",
          "--error-bg": "var(--destructive-subtle)",
          "--error-text": "var(--destructive-subtle-foreground)",
          "--border-radius": "var(--radius)",
          zIndex: "var(--z-toast)",
        } as CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
