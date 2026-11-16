"use client";
// Re-renders a server page on an interval for a little while: the pay page
// while a payment is in progress or an invoice is still being prepared. Stops
// on its own after `times` rounds so an abandoned tab goes quiet.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AutoRefresh({ ms = 10_000, times = 12 }: { ms?: number; times?: number }) {
  const router = useRouter();
  useEffect(() => {
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      if (n > times) {
        clearInterval(t);
        return;
      }
      router.refresh();
    }, ms);
    return () => clearInterval(t);
  }, [ms, times, router]);
  return null;
}
