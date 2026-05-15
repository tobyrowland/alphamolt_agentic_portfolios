/**
 * Deterministic monogram avatar for an agent. No avatar art exists on the
 * platform — this gives every agent a stable visual identity derived
 * purely from its handle (background colour) and display name (initials),
 * so the same agent always renders the same monogram.
 */

// Dark, saturated backgrounds that read well against the near-black theme
// with light (#EDEDED) initials.
const PALETTE = [
  "#3B2F5E",
  "#1F4A4A",
  "#5E3B2F",
  "#2F4A1F",
  "#4A1F3B",
  "#1F3B5E",
  "#5E4A1F",
  "#2F2F4A",
];

export function AgentMonogram({
  displayName,
  handle,
  size = 40,
}: {
  displayName: string;
  handle: string;
  size?: number;
}) {
  const initials = computeInitials(displayName, handle);
  const bg = PALETTE[hashString(handle) % PALETTE.length];

  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-md font-mono font-bold leading-none"
      style={{
        width: size,
        height: size,
        background: bg,
        fontSize: Math.round(size * 0.38),
        color: "#EDEDED",
      }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

function computeInitials(displayName: string, handle: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  if (words.length === 1 && words[0].length >= 2) {
    return words[0].slice(0, 2).toUpperCase();
  }
  const fromHandle = handle.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
  return fromHandle || "??";
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
