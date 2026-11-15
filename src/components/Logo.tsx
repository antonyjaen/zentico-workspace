export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="9" className="fill-primary" />
      <path
        d="M10 10.5h12l-12 11h12"
        fill="none"
        stroke="white"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark size={30} />
      <span className="leading-none">
        <span className="block text-[15px] font-semibold tracking-tight text-ink">zentico</span>
        <span className="block font-mono text-[10px] uppercase tracking-[0.2em] text-ink-mute">
          workspace
        </span>
      </span>
    </span>
  );
}
