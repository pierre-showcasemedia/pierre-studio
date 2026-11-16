# Studio

The admin and client portal for a real estate photo and video business.
`STUDIO.md` has how it works and what to set for a new business;
`CLAUDE.md` has the rules.

```bash
npm ci
npm run dev    # demo mode with sample data until DATABASE_URL is set
```

Checks before every push:

```bash
npm run typecheck && npm run lint && npm run build
for f in scripts/check-*.ts; do npx tsx "$f" || echo "FAILED $f"; done
```
