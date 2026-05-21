import Nav from "@/components/nav";

export default function Loading() {
  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1280px] mx-auto w-full px-4 sm:px-6 py-10 sm:py-14">
          <div className="mb-8">
            <div className="h-6 w-32 bg-bg-card rounded animate-pulse mb-2" />
            <div className="h-4 w-64 bg-bg-card rounded animate-pulse" />
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
          {/* Header skeleton */}
          <div className="bg-bg-card border-b border-white/10 px-3 py-3">
            <div className="flex gap-4">
              {Array.from({ length: 10 }).map((_, i) => (
                <div
                  key={i}
                  className="h-3 bg-white/10 rounded animate-pulse"
                  style={{ width: `${60 + Math.random() * 40}px` }}
                />
              ))}
            </div>
          </div>
          {/* Row skeletons */}
          {Array.from({ length: 20 }).map((_, i) => (
            <div
              key={i}
              className="border-b border-white/[0.06] px-3 py-3 flex gap-4"
            >
              {Array.from({ length: 10 }).map((_, j) => (
                <div
                  key={j}
                  className="h-3 bg-bg-card rounded animate-pulse"
                  style={{ width: `${40 + Math.random() * 60}px` }}
                />
              ))}
            </div>
          ))}
          </div>
        </div>
      </main>
    </>
  );
}
