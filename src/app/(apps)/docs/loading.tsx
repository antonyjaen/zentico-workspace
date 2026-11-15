import { Bone } from "./ui";

export default function DocsLoading() {
  return (
    <main className="sheet flex min-w-0 flex-1 flex-col overflow-hidden" aria-busy="true">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-3">
        <Bone className="h-5 w-20" />
        <Bone className="mx-auto h-9 w-full max-w-xl" />
        <Bone className="h-9 w-24" />
      </div>
      <div className="border-b border-line bg-sheet-muted">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
          <Bone className="h-4 w-40" />
          <div className="mt-4 flex gap-4 overflow-hidden">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="w-[136px] shrink-0">
                <Bone className="aspect-[4/5] w-full rounded-lg" />
                <Bone className="mt-2 h-3.5 w-24" />
                <Bone className="mt-1.5 h-3 w-16" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
        <div className="flex items-center gap-4">
          <Bone className="mr-auto h-4 w-28" />
          <Bone className="h-8 w-72" />
          <Bone className="h-8 w-16" />
        </div>
        <div className="mt-4 overflow-hidden rounded-lg border border-line">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex h-12 items-center gap-3 border-b border-line/70 px-4 last:border-b-0">
              <Bone className="h-5 w-5" />
              <Bone className="h-3.5 flex-1 max-w-xs" />
              <Bone className="ml-auto hidden h-3 w-32 md:block" />
              <Bone className="hidden h-3 w-20 md:block" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
