import { Video } from "lucide-react";

export function NotConfigured({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="grid flex-1 place-items-center p-10 text-center">
      <div className="rise max-w-sm">
        <span
          className="mx-auto grid h-14 w-14 place-items-center rounded-xl border border-line bg-sheet-muted"
          style={{ color: "var(--color-app-meet)" }}
        >
          <Video size={26} aria-hidden />
        </span>
        <p className="mt-6 text-[17px] font-medium text-ink">{title}</p>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-mute">{hint}</p>
      </div>
    </div>
  );
}
