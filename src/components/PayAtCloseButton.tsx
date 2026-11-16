"use client";
// The pay-at-close button on /portal/<slug>/pay (docs/booking-to-payment.md,
// step two). Loads the Titus Browser SDK and, inside the click handler itself
// (the popup must open synchronously), calls titus.checkout({ getId }): getId
// asks our server for the checkout (POST /api/portal/pay/checkout creates or
// reuses it; a canceled one is recreated with a new idempotency version).
//
// Nothing here unlocks anything. onSuccess only asks the server to read the
// checkout back from Titus (POST /api/portal/pay/confirm) and refreshes the
// page; the server moves the invoice to paid solely from the provider's
// status. A blocked popup (checkout() returned null, or onError with code
// popup_blocked) falls back to a same-tab visit to the checkoutUrl from the
// same create call.
import Script from "next/script";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";

const SDK_SRC = "https://assets.gotitus.com/sdk/v1/titus.js";

type CloseResult = { id?: string; loanDecision?: string | null };
type SdkError = { code?: string; message?: string };
type TitusSdk = {
  checkout: (opts: { getId: () => Promise<string>; onSuccess?: (r: { id: string }) => void; onClose?: (r: CloseResult) => void; onError?: (e: SdkError) => void }) => unknown;
};
type TitusWindow = Window & { titus?: TitusSdk; TitusSDK?: new (o: { baseWebUrl: string }) => TitusSdk };
type CreateResponse = { ok?: boolean; paid?: boolean; id?: string; checkoutUrl?: string | null; status?: string; error?: string };

const post = async (path: string, body: Record<string, unknown>): Promise<CreateResponse> => {
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as CreateResponse;
    return r.ok ? { ok: true, ...j } : { ok: false, error: j.error || `request failed (${r.status})` };
  } catch {
    return { ok: false, error: "network" };
  }
};

export default function PayAtCloseButton({ slug, invoiceId, webBase }: { slug: string; invoiceId: string; webBase: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<"review" | "redirect" | "closed" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One create call per click, shared by getId and the popup-blocked fallback.
  const createRef = useRef<Promise<CreateResponse> | null>(null);

  const create = useCallback((): Promise<CreateResponse> => {
    if (!createRef.current) createRef.current = post("/api/portal/pay/checkout", { slug, invoiceId });
    return createRef.current;
  }, [slug, invoiceId]);

  // Staging only: NEXT_PUBLIC_TITUS_WEB_BASE_URL points the SDK at Titus staging.
  const onReady = () => {
    const w = window as TitusWindow;
    if (webBase && w.TitusSDK) {
      try {
        w.titus = new w.TitusSDK({ baseWebUrl: webBase });
      } catch (e) {
        console.error("[titus] staging SDK:", e);
      }
    }
  };

  const fallback = async () => {
    const j = await create();
    if (j.paid) {
      setBusy(false);
      router.refresh();
      return;
    }
    if (j.checkoutUrl) {
      setNote("redirect");
      window.location.href = j.checkoutUrl;
      return;
    }
    setError(j.error && j.error !== "network" ? j.error : "We could not start the application. Please try again in a moment.");
    setBusy(false);
  };

  const onClick = () => {
    setError(null);
    setNote(null);
    setBusy(true);
    createRef.current = null;
    const sdk = (window as TitusWindow).titus ?? null;
    if (!sdk) {
      void fallback();
      return;
    }
    let result: unknown;
    try {
      // Synchronous: the popup opens from the click, then waits on getId.
      result = sdk.checkout({
        getId: async () => {
          const j = await create();
          if (j.paid) {
            setBusy(false);
            router.refresh();
            throw new Error("already paid");
          }
          if (!j.ok || !j.id) throw new Error(j.error || "could not start the application");
          return j.id;
        },
        onSuccess: ({ id }) => {
          // Ask the server to read the checkout back from Titus; it decides.
          post("/api/portal/pay/confirm", { slug, invoiceId, checkoutId: id }).finally(() => {
            setBusy(false);
            router.refresh();
          });
        },
        onClose: ({ loanDecision }) => {
          setNote(loanDecision === "awaiting-approval" ? "review" : "closed");
          setBusy(false);
          router.refresh();
        },
        onError: (e) => {
          if (e?.code === "popup_blocked") {
            void fallback();
            return;
          }
          setError(e?.message ? `Something went wrong: ${e.message}` : "Something went wrong opening the application. Please try again.");
          setBusy(false);
        },
      });
    } catch (e) {
      console.error("[titus] checkout:", e);
      result = null;
    }
    if (result === null) void fallback();
  };

  return (
    <div>
      <Script src={SDK_SRC} strategy="afterInteractive" onReady={onReady} />
      <button type="button" className="btn btn-primary" onClick={onClick} disabled={busy}>
        {busy ? "Opening the application" : "Complete your pay at close application"}
      </button>
      <p className="faint" style={{ marginTop: 14, fontSize: 13, lineHeight: 1.6, maxWidth: "52ch" }}>
        A short application with our payment partner Titus opens in a new window. Most agents hear back right away, and nothing is due from you today.
      </p>
      {note === "review" && (
        <p style={{ marginTop: 12, fontSize: 14, lineHeight: 1.6 }}>Your application is being reviewed. Downloads open as soon as it clears, and we will email you.</p>
      )}
      {note === "redirect" && <p className="muted" style={{ marginTop: 12, fontSize: 14 }}>Taking you to the application.</p>}
      {error && (
        <p style={{ marginTop: 12, fontSize: 13.5, color: "var(--color-live)" }}>{error}</p>
      )}
    </div>
  );
}
