export default function ChatLoading() {
  return (
    <main className="sheet flex min-w-0 flex-1 overflow-hidden" aria-busy="true">
      <div className="hidden w-[300px] shrink-0 flex-col gap-3 border-r border-line p-4 md:flex">
        <span className="h-5 w-20 animate-pulse rounded bg-hover" />
        <span className="h-8 animate-pulse rounded-md bg-hover" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-2.5">
            <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-hover" />
            <span className="h-3 flex-1 animate-pulse rounded bg-hover" />
          </div>
        ))}
      </div>
      <div className="flex-1" />
    </main>
  );
}
