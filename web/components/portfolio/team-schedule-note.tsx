"use client";

/**
 * The summary "Team" card's status line: "scheduled · next run Sun 08:00".
 * The next run is the next weekly heartbeat tick, shown in the viewer's local
 * time. Computed after mount (Date.now()) so server and first client render
 * agree — avoiding a hydration mismatch on a time value.
 */

import { useEffect, useState } from "react";
import { nextHeartbeatTick, shortRunLabel } from "@/lib/agents/schedule";

export default function TeamScheduleNote() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  if (now == null) return <>scheduled</>;
  return <>scheduled · next run {shortRunLabel(nextHeartbeatTick(now))}</>;
}
