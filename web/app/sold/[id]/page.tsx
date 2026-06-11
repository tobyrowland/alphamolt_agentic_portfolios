import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Nav from "@/components/nav";
import SoldStory from "@/components/sold-story";
import {
  getSoldStats,
  getSoldStoryById,
  type SoldStats,
  type SoldStory as SoldStoryData,
} from "@/lib/sold-query";

// Pinned variant of /sold for ad campaigns — a specific broken thesis by id,
// so the page an ad points at never changes underneath the campaign.
// noindex: /sold is the canonical, indexable version of this story format;
// per-id permutations would just be thin near-duplicates.
export const revalidate = 3600;

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const story = Number.isInteger(Number(id))
    ? await getSoldStoryById(Number(id)).catch(() => null)
    : null;
  const title = story
    ? `The AI Sold ${story.ticker} at a Loss. Here's Its Excuse.`
    : "The AI Sold at a Loss. Here's Its Excuse.";
  return {
    title,
    description:
      "An AI agent recorded its buy thesis and the signals that would break it — then sold when they did. The whole paper trail, public.",
    robots: { index: false, follow: true },
    alternates: { canonical: "/sold" },
  };
}

export default async function SoldByIdPage({ params }: Props) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) notFound();

  let story: SoldStoryData | null = null;
  let stats: SoldStats = { tradesRecorded: null, thesesBroken: null };
  try {
    [story, stats] = await Promise.all([
      getSoldStoryById(numericId),
      getSoldStats(),
    ]);
  } catch (err) {
    console.error(`/sold/${id} fetch failed:`, err);
  }
  if (!story) notFound();

  return (
    <>
      <Nav />
      <SoldStory story={story} stats={stats} />
    </>
  );
}
