// CSV download for one section of /admin/reports (admin only, Oct 21 2026).
// GET /api/studio/reports/<revenue|bookings|unpaid|revisions|shooters|clients>?from=YYYY-MM-DD&to=YYYY-MM-DD
// The same functions as the page (src/lib/reports.ts), streamed line by line
// as text/csv. Money leaves the server only in this file's response and on the
// page itself; nothing here logs, posts or emails an amount.
import { requireAdminApi } from "@/lib/admin";
import { loadReportRows } from "@/lib/reports-data";
import { isReportSection, parseRange, sectionCsv } from "@/lib/reports";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ section: string }> }) {
  const admin = await requireAdminApi();
  if (admin instanceof Response) return admin;
  const { section } = await params;
  if (!isReportSection(section)) return Response.json({ ok: false, error: "No such report." }, { status: 404 });
  const url = new URL(request.url);
  const range = parseRange({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
  const rows = await loadReportRows();
  const { filename, lines } = sectionCsv(section, rows, range);
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // A BOM so Excel reads UTF-8 names right; CRLF line ends per RFC 4180.
      controller.enqueue(enc.encode("﻿"));
      for (const line of lines) controller.enqueue(enc.encode(`${line}\r\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
