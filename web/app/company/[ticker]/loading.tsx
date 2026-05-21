import Nav from "@/components/nav";

export default function Loading() {
  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1180px] mx-auto w-full px-4 sm:px-6 py-10 sm:py-14">
          <div className="h-3 w-24 bg-bg-card rounded animate-pulse mb-4" />
          <div className="flex justify-between items-start mb-8">
            <div>
              <div className="h-9 w-40 bg-bg-card rounded animate-pulse mb-2" />
              <div className="h-4 w-64 bg-bg-card rounded animate-pulse" />
            </div>
            <div className="h-8 w-24 bg-bg-card rounded animate-pulse" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 h-48 animate-pulse"
              />
            ))}
          </div>
        </div>
      </main>
    </>
  );
}
