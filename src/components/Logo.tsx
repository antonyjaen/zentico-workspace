export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="8" fill="var(--color-primary)" />
      <path
        d="M10 10.5h12l-12 11h12"
        fill="none"
        stroke="var(--color-primary-ink)"
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
      <LogoMark size={26} />
      <span className="text-[15px] font-semibold tracking-tight text-ink">zentico</span>
      <span className="text-line-strong" aria-hidden>
        /
      </span>
      <span className="text-[15px] text-ink-soft">workspace</span>
    </span>
  );
}
