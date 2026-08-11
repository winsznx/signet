# Phase 12 — Essential operator and proof UI

Result: **PASS.** Both pages build, all checks pass, and the site is deployed.
Date: 2026-08-11
Command: `make web`
Design authority: [`design.md`](../../design.md)

## 1. Two pages, and no third

The PRD scopes this phase to an operator state view and a public proof page, with "no extra product
surfaces". There are two pages. A dashboard that grows a features page is how a verification tool
turns into marketing, and this one has nowhere to grow.

## 2. Static, and that is the point

The site is generated from the repository's own evidence: `evidence/claim-ledger.json`,
`evidence/receipts/` and `docs/run/run-state.json`. No API, no database, no server.

That is not a shortcut taken because the coordinator is not deployed. A proof page backed by a live
service asks its reader to trust a server we run, which is the opposite of what a proof page is for.
Every figure traces to a committed file, and the footer tells the reader the command that checks it:

```bash
pnpm --filter @signet/verifier verify:receipt <transaction hash>
```

The phase asks for a static fallback. Static is the only mode, so the fallback cannot rot.

## 3. The pages cannot show only good news

A proof page that renders what passed and quietly omits the rest is a brochure. Three checks stop
that, and they fail the build:

```text
ok   every claim in the ledger appears on the proof page       18 claims
ok   every limitation is shown, not summarised away
ok   claims that are not verified are still rendered           3 not verified
ok   receipts that only prove a seam are labelled as such      settles:false is visible to a reader
```

Limitations render at the same weight as the claim, under "What this does not prove", with the
Ember accent on the list markers. A receipt marked `settles: false` is labelled "seam proof only" in
the transactions table, so a reader cannot mistake a seam demonstration for a settlement.

## 4. Accessibility

Structural checks, per page: a language attribute, exactly one `h1`, a skip link that reaches the
main landmark, labelled `nav` and `section` landmarks, every `aria-labelledby` pointing at an element
that exists, scoped table headers, no skipped heading level, alt text on images, no scripts, and
nothing loaded from another origin except the XRPL explorer links.

Colour contrast is computed from the palette rather than eyeballed, for the pairs the pages actually
use. **design.md's Fog (`#71717a`) is 4.40:1 on Paper (`#f4f4f5`), below the 4.5 needed for normal
text.** design.md assigns Fog to helper text, and on Snow it clears the threshold at 4.83:1, but
section notes sit on the canvas. Those use Steel (`#52525b`, 7.03:1) instead. The failing ratio is
asserted as a known fact in the test, because the two greys are close enough that a future edit would
swap them back without anyone noticing.

These checks catch what a static page can get wrong. They are not a substitute for someone using the
page with a screen reader, which has not happened.

## 5. Design fidelity

Zinc-first with Ember as functional punctuation: 36px cards, 14px buttons, 10000px pills, 1px
hairline borders instead of shadows, 56px/600 display at 1.12 line height, 14–15px body, 4px base
unit, compact density.

Cosmica is not distributed with this repository, so the stack falls through to DM Sans and then the
system geometric sans. Shipping a font we have no licence to redistribute would be a worse choice
than losing the exact letterforms.

## 6. Deployed

No new credentials were needed. The local Wrangler OAuth login already carried `pages (write)` for
account `eb94a234b390bb8da04babac718d6c92`, which was confirmed by listing existing projects before
anything was created.

```text
https://signet-proof.pages.dev/           the proof page
https://signet-proof.pages.dev/operator   the operator view
```

The strict CSP survives the hop, which is the part worth checking rather than assuming:

```text
content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self';
                         base-uri 'none'; form-action 'none'; frame-ancestors 'none'
referrer-policy: no-referrer
x-content-type-options: nosniff
```

Pages redirects `.html` URLs to extensionless ones, so the internal navigation was 308-ing on every
click. The links are absolute and extensionless now.

## 7. Limitations

- The two-minute judge path still has not been timed by a third party.
- The judge-path timing the completion gate asks for was not measured with a stopwatch by a third
  party. Both pages are single-screen, static, and cross-linked, and the proof page leads with the
  claims, but "under two minutes" is a claim about someone else's experience and has not been tested
  on one.
- No screen-reader testing, no keyboard walkthrough by a human, no browser matrix. The checks are
  static analysis of the emitted HTML.
- The operator view is read-only and rebuilt at build time. There is no live state, because there is
  no running coordinator to read.
