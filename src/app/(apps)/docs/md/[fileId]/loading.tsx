import { Loader2 } from "lucide-react";
import { Bone } from "../../ui";

export default function MarkdownLoading() {
  return (
    <main className="sheet flex min-w-0 flex-1 flex-col overflow-hidden" aria-busy="true">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2">
        <Bone className="h-8 w-20" />
        <span aria-hidden className="mx-1 h-5 w-px bg-line" />
        <Bone className="h-5 w-5" />
        <Bone className="h-4 w-48" />
        <span className="flex-1" />
        <Bone className="h-8 w-24" />
      </div>
      <div className="grid min-h-0 flex-1 place-items-center bg-sheet-muted">
        <Loader2 size={22} className="animate-spin text-ink-mute" aria-hidden />
      </div>
    </main>
  );
}
