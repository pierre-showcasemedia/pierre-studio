"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function Form({ supportEmail }: { supportEmail: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [demoLink, setDemoLink] = useState<string | null>(null);
  const [demoLimited, setDemoLimited] = useState(false);
  const linkError = useSearchParams().get("error");
  const expired = linkError === "expired";
  const used = linkError === "used";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("sending");
    try {
      const r = await fetch("/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const j = r.ok ? await r.json().catch(() => ({})) : {};
      if (j?.demo && typeof j.link === "string") setDemoLink(j.link);
      if (j?.demo && j.limited) setDemoLimited(true);
      setState(r.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  };

  if (state === "sent" && demoLink) {
    return (
      <div style={{ marginTop: 34 }}>
        <p className="muted" style={{ fontSize: 14.5, lineHeight: 1.7 }}>Demo mode: no email is sent. Continue as {email}.</p>
        <a href={demoLink} className="btn btn-primary" style={{ marginTop: 18 }}>Continue to the demo →</a>
      </div>
    );
  }
  if (state === "sent" && demoLimited) {
    return (
      <p style={{ marginTop: 34, fontSize: 15.5, lineHeight: 1.7 }}>
        Demo mode: that address asked for a link too many times in the last 15 minutes, so no link was handed back.
      </p>
    );
  }
  if (state === "sent") {
    return (
      <p style={{ marginTop: 34, fontSize: 15.5, lineHeight: 1.7 }}>
        Check your inbox. If that email is on file, a sign-in link is on its way.
        It expires in 15 minutes.
      </p>
    );
  }
  return (
    <form onSubmit={submit} style={{ marginTop: 34 }}>
      {expired && (
        <p style={{ marginBottom: 16, fontSize: 13.5, color: "var(--color-live)" }}>
          That link has expired. Enter your email for a fresh one.
        </p>
      )}
      {used && (
        <p style={{ marginBottom: 16, fontSize: 13.5, color: "var(--color-live)" }}>
          That link was already used. Each link works once, so enter your email for a fresh one.
        </p>
      )}
      <div className="field">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@brokerage.com"
          aria-label="Email address"
        />
      </div>
      <button type="submit" className="btn btn-primary" disabled={state === "sending"} style={{ marginTop: 18 }}>
        {state === "sending" ? "Sending…" : "Email me a sign-in link →"}
      </button>
      {state === "error" && (
        <p style={{ marginTop: 14, fontSize: 13.5, color: "var(--color-live)" }}>
          We could not send the link. Please try again, or email{" "}
          <a href={`mailto:${supportEmail}`} style={{ textDecoration: "underline" }}>{supportEmail}</a>.
        </p>
      )}
    </form>
  );
}

export default function LoginForm({ supportEmail }: { supportEmail: string }) {
  return (
    <Suspense>
      <Form supportEmail={supportEmail} />
    </Suspense>
  );
}
