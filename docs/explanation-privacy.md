# Privacy: what the Obscurity Engine stores, and how to get it back or gone

The short version: **nothing is stored server-side unless you log in.** Below
is exactly what changes when you do, in plain language, backed by the actual
schema and endpoints (see [reference-schema.md](reference-schema.md) and
[reference-api.md](reference-api.md) for the technical detail).

## If you never log in

Type a Last.fm username, get recommendations. The backend fans out to the
Last.fm API on your behalf and returns a response — it does not create a
`users` row, does not mint a session, and (unless a database is even
configured on the server) doesn't persist anything about that run at all.

Two exceptions, both anonymous by design:
- **`click_listen`/`share` events** — if you click "listen on Spotify" or hit
  share, the frontend fires a `POST /api/events` beacon (via
  `navigator.sendBeacon`, survives the page navigating away). This event
  carries a `rec_id`/`run_id` (an opaque id for *that recommendation*, not
  you) and, if you happen to be logged in, your `user_id` — logged out, there
  is no `user_id` to attach.
- **Listener-count observations** — every discovery run, logged in or not,
  causes the artists it fetches from Last.fm to get their listener counts
  recorded into `artist_observations` (one row per artist per day). This is
  aggregate, artist-keyed data (not tied to any user) built entirely from
  numbers the run already fetched — **zero extra Last.fm calls, zero personal
  data**. It powers future "this artist is gaining traction" signals, not
  anything about you specifically.

Neither of these requires you to have an account, and neither is retrievable
or deletable *as you* — there's no `user_id` on them to key a lookup or
delete by.

## What is NOT stored, even when you're logged in

This phase deliberately does **not** poll or store your Last.fm scrobble
history. The engine reads your recent plays live from the Last.fm API each
time you run a discovery — it never builds a copy of your listening history
in its own database. What gets saved is described below: your saves, your
dismissals, your click/share events, and metadata about each discovery run
(the period/appetite you picked, the artists it surfaced) — not your
scrobbles themselves.

## If you log in with Last.fm

Logging in (`connect last.fm` → Last.fm's own auth page → redirected back)
creates:
- a `users` row: a synthetic id and your Last.fm username, stored
  **lowercased** so a later capitalization rename still matches — no email,
  no password, nothing beyond the username you already made public by having
  a Last.fm account.
- a `sessions` row: proof you're logged in. See "Session tokens," below.

From then on, discovery runs you make while logged in are recorded (a `runs`
row: which account you analyzed, which period/appetite, when), and:

| Action | What's stored |
|---|---|
| **Save** an artist | A row in `saved_artists` — the artist, when, and which recommendation it came from. |
| **Dismiss** an artist | A row in `dismissed_artists` — that artist stops showing up in your results from then on, until you undo it. |
| **Click "listen"** or **share** | A row in `events` — which action, on which recommendation, when. No IP address or user agent is stored on the row itself. |

None of this is used for anything beyond running the app for you (showing
your saved list, keeping dismissed artists out of your results) and internal
product analytics (e.g. "are people saving what we recommend").

## Exporting your data

`GET /api/me/data` (with your session's `Authorization: Bearer` header)
returns a full JSON export of everything keyed to your account: your saves,
your dismissals, your events, and your run history (period/appetite/when —
not the full artist lists). See [reference-api.md](reference-api.md#get-apimedata)
for the exact shape.

## Deleting your data

`DELETE /api/me/data` permanently removes everything tied to your account:
your runs (and everything that cascades from them — the recommendations
generated for you, impressions, and events), then your account row itself
(which cascades your session, saves, and dismissals). It returns `204` on
success. This is not a soft delete — there is no "undo" once it's called, and
no ops-side backup process retains it beyond the database's own operational
backups.

What this does **not** touch: the `artist_observations` rows your past runs
contributed to. Those were never tied to your `user_id` in the first place —
they're aggregate artist-listener counts, not "your" data — so there's
nothing about you left to delete from that table.

## Session tokens

A session token is 32 random bytes (64 hex characters when handed to your
browser). The server **never stores the raw token** — only its SHA-256 hash,
in `sessions.token_hash`. A database leak of that table can't be replayed as
a login, because the hash can't be reversed back into the token your browser
holds. Your browser sends the raw token as `Authorization: Bearer <token>` on
every write and personal-read request; the server hashes what it receives and
looks up the match.

Sessions expire **90 days** after creation. There's no active cleanup job in
this phase — an expired session simply stops resolving to a user (the lookup
query filters `expires_at > now()`), it isn't proactively deleted from the
table. Logging out (`DELETE /api/auth/session`) deletes the row immediately
and is idempotent — calling it with no session, or an already-expired one,
still returns `204`.

The frontend stores the token in `localStorage`. If that's unavailable
(private browsing, storage quota), the app degrades to "logged out" rather
than breaking.

## If persistence isn't configured on the server at all

The server operator can run the Obscurity Engine with no database configured
(`DATABASE_URL` unset). In that mode none of the above tables exist to write
to — login, save, dismiss, and personal-data endpoints all respond `503`
rather than silently pretending to work, and `GET /api/status` reports
`"postgres": "disabled"`. See
[howto-run-locally.md](howto-run-locally.md#troubleshooting) for how to tell
"disabled" (intentional) apart from "error" (misconfigured).

## Related

- [reference-schema.md](reference-schema.md) — the tables, columns, and retention rules referenced above
- [reference-api.md](reference-api.md) — the endpoints (`/api/auth/session`, `/api/events`, `/api/me/*`, `/api/status`)
- [howto-run-locally.md](howto-run-locally.md) — running with/without persistence locally
