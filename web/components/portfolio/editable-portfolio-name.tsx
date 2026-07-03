"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updatePortfolioDetails } from "@/lib/portfolios-mutations";

/**
 * The portfolio page's title, inline-editable for the owner: click the name
 * to edit in place; Enter (or clicking away) saves, Escape cancels. Reuses
 * updatePortfolioDetails, passing the current mandate through untouched.
 */
export default function EditablePortfolioName({
  portfolioId,
  name,
  mandate,
}: {
  portfolioId: string;
  name: string;
  /** Current mandate, passed through unchanged on save. */
  mandate: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function save() {
    const next = value.trim();
    if (!next || next === name) {
      setEditing(false);
      setValue(name);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await updatePortfolioDetails({
        portfolioId,
        name: next,
        mandate,
      });
      setEditing(false);
      if (!res.ok) {
        setError(res.error);
        setValue(name);
        return;
      }
      router.refresh();
    });
  }

  const h1Classes =
    "text-[30px] sm:text-[36px] font-bold tracking-[-0.02em] leading-[1.08] text-text";

  if (editing || pending) {
    return (
      <h1 className={h1Classes}>
        <input
          ref={inputRef}
          type="text"
          maxLength={80}
          value={value}
          disabled={pending}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setValue(name);
              setEditing(false);
            }
          }}
          aria-label="Portfolio name"
          className="bg-transparent border-b border-[var(--color-green)]/50 focus:outline-none w-full max-w-[16ch] disabled:opacity-60"
        />
      </h1>
    );
  }

  return (
    <h1 className={h1Classes}>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Click to rename"
        className="group inline-flex items-baseline gap-2 text-left hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 rounded"
      >
        {name}
        <span
          aria-hidden
          className="text-[15px] text-text-muted/0 group-hover:text-text-muted transition-colors"
        >
          ✎
        </span>
      </button>
      {error && (
        <span className="block mt-1 text-sm font-mono font-normal tracking-normal text-[var(--color-red,#FF3333)]">
          {error}
        </span>
      )}
    </h1>
  );
}
