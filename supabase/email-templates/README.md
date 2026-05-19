# Supabase Auth email templates

Source of truth for the HTML used by Supabase Auth's transactional emails.

Supabase stores these templates **only in the project dashboard** — they
are not picked up from this directory automatically. These files exist so
the templates are version-controlled, reviewable, and recoverable. When a
template here changes, paste the new HTML into the dashboard by hand.

## Deploy

Supabase dashboard → **Authentication → Email Templates** → select the
template → replace the body with the file's contents → **Save**.

| File | Dashboard template | Supabase variables used |
|---|---|---|
| `magic-link.html` | Magic Link | `{{ .ConfirmationURL }}` |

Only the **Magic Link** template is in use — the app's sole auth path is
`signInWithOtp` (`web/components/login-form.tsx`). The other templates
(Confirm signup, Reset password, etc.) are left on Supabase defaults.

## Notes

- All CSS is inline and the layout is table-based — email clients strip
  `<style>` blocks and don't support modern CSS layout.
- The design is dark to match the site (`web/app/opengraph-image.tsx`
  palette: `#0A0A0A` background, `#EDEDED` text, `#00FF41` accent).
- `{{ .ConfirmationURL }}` is substituted by Supabase with the one-time
  sign-in link; it appears both as the CTA button and as a copy-pasteable
  fallback link.
