# Team SOPs

The pages at `/admin/sops`: one markdown file per SOP here, the index (titles,
departments, what each one covers) in `src/lib/sops.ts`, read by
`src/lib/sop-content.ts` and rendered by `src/lib/sop-markdown.ts`.

These are general SOPs for how the studio works. Rewrite them in the
business's own words once the owner has walked you through how they run
their jobs (Call 1 and Call 2), and add their own.

## Words that fill themselves in

`{{name}}`, `{{owner}}`, `{{turnaround}}`, `{{supportEmail}}`, `{{phone}}`,
`{{timeZone}}` and `{{portal}}` are replaced from `src/lib/business.ts` when
a page is read, so a buyer's SOPs carry their name without an edit.

## Rules for the words

- Plain markdown: `##` and `###` headings, paragraphs, lists, tables, links
  to another SOP (`/admin/sops/<slug>`) or an `https` page, and callouts
  (`> [!note] Title`, kinds: gap, stale, pending, verified, note).
- No em dashes, no secrets, no client names, emails or phone numbers.
- Every SOP sits under at least one department. `npx tsx scripts/check-sops.ts`
  checks all of it.
