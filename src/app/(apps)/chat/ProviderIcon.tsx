// Monochrome marks of the connected-app providers (currentColor), for Settings and chat avatars.
import { Hash } from "lucide-react";

export type ProviderIconId = "github" | "google" | "atlassian" | "notion" | "slack";

export function ProviderIcon({ id, size = 20, className = "" }: { id: ProviderIconId; size?: number; className?: string }) {
  if (id === "slack") return <Hash size={size} className={className} aria-hidden />;
  const common = { width: size, height: size, viewBox: "0 0 24 24", className, "aria-hidden": true } as const;
  switch (id) {
    case "github":
      return (
        <svg {...common} fill="currentColor">
          <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2 0-.3-.5-1.5.2-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.6 18.3 5 18.3 5c.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
        </svg>
      );
    case "google":
      return (
        <svg {...common} fill="currentColor">
          <path d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27 3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10 5.35 0 9.25-3.67 9.25-9.09 0-1.15-.15-1.81-.15-1.81Z" />
        </svg>
      );
    case "atlassian":
      return (
        <svg {...common} fill="currentColor">
          <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53M7.2 6.35c0 2.4 1.96 4.34 4.35 4.35h1.79v1.71c0 2.4 1.95 4.33 4.35 4.34V7.19a.84.84 0 0 0-.84-.84H7.2M2.88 10.71c0 2.4 1.96 4.35 4.36 4.35h1.79v1.71C9.03 19.17 11 21.1 13.37 21.1v-9.55a.84.84 0 0 0-.84-.84H2.88Z" />
        </svg>
      );
    case "notion":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round">
          <path d="M4.5 4.5 15.5 3.5l4 3v13l-12 1-3-3.5z" />
          <path d="M9 9v7.5M9 9l6 7.5V8.5" />
        </svg>
      );
  }
}
