import Nav from "@/components/nav";

export default function Loading() {
  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[760px] mx-auto w-full px-4 sm:px-[18px] py-6">
          {/* breadcrumb */}
          <div className="h-3 w-32 bg-bg-card rounded animate-pulse mb-4" />
          {/* h1 + status */}
          <div className="flex items-center gap-3 mb-3">
            <div className="h-7 w-48 bg-bg-card rounded animate-pulse" />
            <div className="h-5 w-28 bg-bg-card rounded animate-pulse" />
          </div>
          <div className="h-3 w-64 bg-bg-card rounded animate-pulse mb-4" />
          <div className="h-12 w-full bg-bg-card rounded animate-pulse mb-4" />
          {/* stat row */}
          <div className="h-14 w-full border-y border-white/[0.09] animate-pulse mb-3.5" />
          {/* blocks */}
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded-[14px] border border-white/[0.09] bg-bg-card h-40 animate-pulse mt-3.5"
            />
          ))}
        </div>
      </main>
    </>
  );
}
