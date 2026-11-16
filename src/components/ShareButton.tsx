"use client";
// Copies the listing's public preview link (/share/<token>), for agents to
// send homeowners a view-only, watermarked gallery with no download access.
import { useState } from "react";
import { CheckIcon, LinkIcon } from "@/components/gallery/icons";
import "@/styles/gallery.css";

export default function ShareButton({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const url = `${window.location.origin}/share/${token}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Copy this share link:", url);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  return (
    <button
      type="button"
      onClick={copy}
      className={`chip g-pill${copied ? " g-pill--ink" : ""}`}
      title="Copy a view-only preview link for homeowners: watermarked, no downloads"
      aria-live="polite"
    >
      {copied ? <CheckIcon /> : <LinkIcon />}
      {copied ? "Link copied" : "Share preview"}
    </button>
  );
}
