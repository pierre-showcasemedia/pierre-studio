// Sticky banner shown to an admin while impersonating a client in the portal.
export default function ViewAsBanner({ email, exitAction }: { email: string; exitAction: () => Promise<void> }) {
  return (
    <div
      style={{
        position: "sticky", top: 0, zIndex: 80,
        background: "#0B0C0F", color: "#FFFFFF",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 16,
        padding: "10px 18px", fontSize: 12.5, letterSpacing: ".08em",
      }}
    >
      <span style={{ textTransform: "uppercase", letterSpacing: ".14em", fontSize: 10, opacity: 0.7 }}>Viewing as</span>
      <strong style={{ fontWeight: 500 }}>{email}</strong>
      <form action={exitAction}>
        <button
          type="submit"
          style={{
            background: "#FFFFFF", color: "#0B0C0F", border: 0, borderRadius: 999,
            padding: "6px 14px", fontSize: 12, cursor: "pointer",
          }}
        >
          Exit client view
        </button>
      </form>
    </div>
  );
}
