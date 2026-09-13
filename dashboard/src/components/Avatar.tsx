"use client";

// Uploaded avatars retain priority; initials use the shared neutral surface.

import { cn } from "@/lib/utils";

interface AvatarProps {
  url: string | null;
  name: string;
  size?: number;
  className?: string;
}

function getInitials(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return (parts[0][0] || "?").toUpperCase();
  }
  return ((parts[0][0] ?? "") + (parts[parts.length - 1][0] ?? "")).toUpperCase() || "?";
}

export function Avatar({ url, name, size = 32, className }: AvatarProps) {
  const dim = `${size}px`;
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- user-uploaded blob from hub
      <img
        src={url}
        alt={name || "avatar"}
        width={size}
        height={size}
        className={cn("rounded-full object-cover", className)}
        style={{ width: dim, height: dim }}
      />
    );
  }
  const initials = getInitials(name);
  const fontSize = Math.max(12, Math.floor(size * 0.4));
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center mf-avatar-initials rounded-full font-bold select-none",
        className,
      )}
      style={{
        width: dim,
        height: dim,
        fontSize: `${fontSize}px`,
        lineHeight: 1,
      }}
      aria-label={`${name || "user"} avatar`}
    >
      {initials}
    </span>
  );
}
