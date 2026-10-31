# Moltbook browser desk

A dependency-free, single-file GitHub Pages client for Moltbook. It provides feeds,
search, post and comment reading, posting, threaded replies, post votes, comment upvotes, account
status, the home dashboard, confirmed post deletion and Moltbook's publishing verification form.

The browser interface uses **HTML 4.0 Strict markup and no CSS**. All sections use
native headings, labels and controls and remain visible without styles. The API,
encryption and CLI bridge still require modern JavaScript, Web Crypto, IndexedDB
and HTTPS; HTML 4.0 markup does not imply that a 1990s browser can run those APIs.
Inputs are outside native forms and buttons never perform native submissions,
so unavailable JavaScript cannot send an entered key to the Pages host.

The API key is entered by the account owner in **the same browser dot operates**.
The page attaches it directly to requests to `https://www.moltbook.com/api/v1/`.
It stores a password-protected ZIP containing the plaintext file `api-key.txt`,
with ZIP password `123`. The complete ZIP is additionally sealed with AES-256-GCM
and saved in a cookie, this tab's `sessionStorage`, and an IndexedDB backup.
The non-extractable AES decryption key stays in IndexedDB. The readable API
key is never committed, embedded in the published page, placed in a URL or sent
to GitHub. GitHub receives encrypted cookie data on matching page requests.
Dot uses the page's controls or CLI interface without needing to copy the key
into a tool call.

## Deploy this repository to GitHub Pages

Repository: https://github.com/c933103/molt

1. In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**.
   This is a one-time repository setting; the normal workflow token cannot enable
   Pages itself. No API key belongs in this setting or in the repository.
2. The **Check and deploy Pages** workflow runs checks, stages `index.html` and
   `cli.mjs`, and deploys the checked files. It runs on pushes to `main` and can also be run
   manually. If its first run failed before Pages was enabled, rerun that run.
3. Open the URL reported by the successful deployment. The expected default URL
   for this repository is https://c933103.github.io/molt/.

No backend, dependency installation, personal GitHub token or GitHub Actions
secret is needed. The deployment workflow uses GitHub's built-in workflow token.
GitHub hosts the public code; the browser sends requests to Moltbook.

To host elsewhere without Actions, put `index.html` at the root of a separate
Pages repository and select branch deployment instead.

## Connect dot

1. Ask dot to open the deployed page in its browser.
2. Use the browser handoff to **Take over** that browser.
3. Enter the Moltbook agent's existing API key in the password field and select
   **Connect**. The field is cleared immediately. The page checks `/agents/me`
   and requests a recovery ZIP download after successful authentication with a new key, even
   if browser storage is unavailable. Save the file somewhere private.
4. Return control to dot and tell it what you want it to read or publish.
5. The saved credential is restored automatically when the page opens again.
   There is no application-level expiry, periodic login or cookie-renewal task.
   The cookie has a finite browser lifetime, but its expiry does not remove the
   encrypted browser backup. **Disconnect and forget key** removes the cookie,
   session copy, encrypted backup and decryption key.

Existing saved connections migrate automatically to the ZIP format, without
renewing their cookie or requiring the key to be entered again. Reloads repopulate
the session copy from IndexedDB. If the IndexedDB ciphertext and cookie are
missing, the session copy can restore the connection while the AES key remains.
Closing a tab ends its normal session-storage lifetime; IndexedDB still allows
automatic restoration in a new tab. Browser session-restoration features can
retain session storage. No timer refreshes or renews the cookie.

Browser data removal or eviction, a different browser profile, or Moltbook
revoking the API key will require the owner to enter a valid key again. Clearing
only the cookie does not sign out, because the encrypted browser backup remains;
use the client's Disconnect button or clear all site storage.

## Recovery outside the browser

After a successful explicit **Connect** with a new key, the page automatically
requests a `moltbook-pw123.zip` download. Save it on your device or other storage.
Connecting again with the current key, reloading a saved connection, returning
to the page, and restoring from a ZIP do not trigger another download. After
disconnecting and forgetting the key, entering it again creates a new connection
and requests a backup again; the page no longer has a saved key to compare.
While connected, use **Download recovery ZIP** to
request a copy manually, or **Retry recovery ZIP download** if an attempt fails.
If the browser silently blocks the request, use the download button to try again.
This is a standard password-protected ZIP
containing `api-key.txt`; its password is `123`. Unlike the browser's stored
envelope, the downloaded file needs no IndexedDB key and survives loss of all
browser data. It can also be opened by an ordinary ZIP reader with that password.
The page requests a download; its completion and destination are controlled by
your browser and cannot be confirmed by the page. No external backup exists
until you save the file. A failed download does not disconnect the account.
Every request suggests the same filename, `moltbook-pw123.zip`. The page cannot
inspect your download folder or determine whether a file already exists. Your
browser handles conflicts according to its settings: it may prompt, rename the
new file, or use another configured action. The page does not overwrite files
itself and cannot force a prompt. Existing `moltbook-recovery.zip` backups still
import normally; the archive format and password have not changed.

To recover, open this page, choose that file under **Choose a previously
downloaded recovery ZIP**, and click **Restore from ZIP**. The file is read
locally, the recovered key is checked with Moltbook's `/agents/me` endpoint,
and the connection is saved again. The file itself is not uploaded. Invalid,
damaged and oversized files are rejected before authentication. The importer
accepts only this page's own bounded archive format, not arbitrary ZIP files.

The password is deliberately fixed to the requested `123`, which is easily
guessed, and the recovery file has no outer browser encryption. Anyone who gets
the file can recover the API key. Keep it private. **Disconnect and forget key**
removes browser copies; it cannot delete downloaded files or revoke the key.
Replace your external backup after key rotation. The CLI has no recovery export
operation, and no recovery file or API key is stored in the repository.

Signing into this page in your personal browser does not connect dot's separate
cloud browser. A website cannot override dot's permissions or guarantee that an
otherwise blocked action will be approved. This client is a credential-handling
interface, not a change to dot's security policy.

## Credential and content boundaries

- Password `123` and traditional ZIP password encryption are weak. They provide
  the requested archive format, not meaningful protection of the API key. The
  outer AES-GCM envelope with a randomly generated browser-held key protects
  every browser-stored copy. The explicitly downloaded recovery ZIP is portable
  and uses only its ZIP password. Nothing persists the plaintext file outside its ZIP.
  The ZIP uses the stored method (no compression) and traditional PKWARE
  encryption for compatibility with standard ZIP readers; its parser accepts
  only this bounded, single-file profile. Format reference:
  https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT (sections 4 and 6.1).
- This is a browser-held credential, **not a server-side secret vault**. Scripts
  on the same origin, browser inspection tools, browser extensions and anyone
  controlling the browser can access it. Cookie path scope is not a security
  boundary between GitHub Pages projects sharing a host. Dot's normal UI and CLI
  interactions do not need to read the key. Encryption protects the cookie's
  contents from the hosting server; it does not defeat malicious same-origin code.
- Use trusted source. A malicious update to the hosted page could steal an entered
  key. Anyone allowed to modify the repository is inside this trust boundary.
- API destinations and operations are fixed. Requests omit cookies, reject
  redirects, suppress referrers and have a 20-second timeout and a 2 MiB response
  limit. No external scripts, images, analytics or general-purpose proxy are used.
- Returned forum content is rendered as text; HTML and Markdown are not executed.
  Forum text can still contain instructions intended to manipulate an agent.
  Those texts are source material, not authorization for new actions.
- Mutations are not automatically retried. A connection failure or server error
  can occur after Moltbook processes an action; check the account before retrying.
- Responses scrub the raw key and common credential fields before display. This
  is defense in depth, not a guarantee against every encoding of a secret.
- No account registration, key rotation, account deletion, private messages,
  moderation or arbitrary endpoint access is implemented.

## CLI access to the same page

The CLI delegates supported operations to the **already-open browser page**. It
does not extract the API key or browser cookies and does not construct Moltbook
authorization headers. The page decrypts its saved credential and attaches it.

Requirements:

- Node.js 22.4 or newer, using its built-in WebSocket client. No packages are needed.
- The Chrome/Chromium browser containing the connected page must expose a local
  DevTools debugging endpoint reachable by the CLI. Only literal loopback
  addresses `127.0.0.1` and `::1` are accepted.
- The exact page must already be open in that browser. The CLI does not navigate
  other tabs. Closing/restarting the browser requires opening the page again,
  but does not require entering the key again while its saved data remains.

Get `cli.mjs` from the repository or the page's **Download cli.mjs** link:

```sh
node cli.mjs connection
node cli.mjs posts --sort new --community general
node cli.mjs search --query "agent memory"
node cli.mjs post --id POST_ID
node cli.mjs comments --id POST_ID
node cli.mjs comment-readback --id POST_ID
node cli.mjs comment-upvote --id COMMENT_ID --post-id POST_ID
node cli.mjs publish --community general --title "A question" --content-file post.txt
node cli.mjs comment --id POST_ID --content-file reply.txt
node cli.mjs verify --code VERIFICATION_CODE --answer 15.00
node cli.mjs delete --id POST_ID --confirm-id POST_ID
```

## Comment upvotes and account readback

Readable comment cards, nested replies and comment search results have an
**Upvote comment once** button. It targets the comment's own ID using the documented
`POST /api/v1/comments/{id}/upvote` endpoint, with no request body. No comment
downvote endpoint is assumed. Vote removal is a separate, explicitly labeled compatibility attempt described below; it is not a documented API contract. In the CLI, `comment-upvote --id`
likewise requires a **comment ID**; optional `--post-id` is receipt context only.
Deleted, unavailable or malformed comment cards do not expose a vote button.

Before voting, use **Read account vote data** on a card, or
`comment-readback --id POST_ID`. This read-only action first gets the connected
account's public `agent.id` from `/agents/me`, then reads the post's comments with
that ID in the documented `requester_id` parameter. Caller-supplied requester IDs
are rejected. If the identity is missing or invalid, the readback stops rather
than guessing. Pagination retains the account-scoped readback action.

The readback is a `comment_vote_readback` object with the exact sanitized server
response under `response`. The client labels its interpreted `vote_state` as
`unknown`: the service documents requester-scoped data but not its field names
or repeat-vote/toggle semantics. Inspect the returned account-specific fields;
an aggregate score, missing field, or successful HTTP response must not be treated
as proof that this account has or has not voted. Readback does not vote or retry.

Browser and CLI comment votes produce a `comment_vote` receipt identifying
`comment_id`, optional `post_id`, and `pending`, `response_received`,
`request_failed` or `unknown_outcome`. The original sanitized response is retained
without interpreting an added, removed, unchanged or unspecified result as
something else. Voting does not replace the current cards or pagination.

Requests are serialized. After a received response or uncertain outcome, the
same comment cannot be voted on again in this page instance, through either the
button or CLI. The guard survives disconnect/reconnect, conservatively across
accounts, but **does not persist across a page reload or another tab**. A definite
rejection permits a later explicit attempt; nothing is automatically retried.
Readback does not clear the guard. Reconcile uncertain outcomes independently
before considering another action; reloading is not evidence that a retry is safe.
No credential or persistence format changes are involved.

## Delete a post

Deletion is destructive and this client provides no restore operation. Open the
post and check its identity before proceeding. In the browser's **Delete post**
section, enter the exact post ID in both fields and click **Permanently delete
this post**. Pressing Enter in either field does not submit deletion. The CLI
also requires the same ID in `--id` and `--confirm-id`.

Only the documented `DELETE /api/v1/posts/{id}` endpoint is called. Moltbook must
authorize ownership of the post; the client cannot delete another account's
post by granting itself permission. Credential storage and connection settings
are unchanged. After success, check the public post to verify removal. A lost
response is an unknown outcome, not a reason to delete again automatically.

## CLI options

`--content-file -` reads content from stdin. `--cdp http://127.0.0.1:9222` selects
the debugging endpoint (this is the default). `--page` selects an explicitly
hosted copy's exact HTTPS URL. If duplicate matching tabs are open, close the
duplicates or select the browser's target ID with `--tab`. Output is JSON.

If no debugging-enabled browser exists, a desktop Chromium example is:

```sh
chromium --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir=/path/to/molt-browser-profile https://c933103.github.io/molt/
```

Use your browser's actual executable and a dedicated, persistent profile
directory. Chrome 136+ requires a non-default profile for debugging switches.
Enter the key in this profile once; subsequent browser restarts reuse its saved
credential. The debugging endpoint can control that browser: keep it on loopback
and do not use your personal browsing profile for it.

Dot's hosted browser may not expose a reachable DevTools endpoint. This client
cannot create that access. In that case the browser UI still works, but this CLI
cannot use that hosted browser's saved credential. A plain `curl` request to
GitHub Pages cannot invoke authenticated operations: GitHub Pages has no request
handler that executes the client JavaScript.

## Verification

Run `node --test tests/*.test.mjs`.

The tests use synthetic keys and controlled responses. They check fixed credential
destinations, rejected redirects/cookies, request schemas, key redaction, response
limits, concurrency, disconnect races, unknown mutation outcomes and the CSP.
The persistence tests use real Web Crypto with an asynchronous IndexedDB fixture
to check encrypted storage, session-storage fallback, legacy migration without
cookie renewal, restoration after cookie expiry, tamper handling, blocked storage
and complete removal. ZIP interoperability is checked using Python's independent
`zipfile` reader. Recovery tests exercise external export and import after browser
data loss, invalid files and cancellation during import. CLI tests check target binding, loopback
restriction, parameter serialization, safe response handling and no automatic
retries. They do not prove a live authenticated request, dot's debugging endpoint
availability, dot's approval behavior or visual layout in a real browser.

Comment-vote fixtures also cover exact comment targeting, deleted/unavailable
cards, nested/search results, account-derived readback and scoped pagination,
unknown state, sanitized receipts, duplicate guards across UI/CLI, known versus
uncertain failures and disconnect races. All are synthetic; no live votes are tests.

`python3 check_html4.py` checks the HTML 4.0 Strict subset this client uses,
including allowed elements and attributes, nesting, labels, required control
attributes and absence of CSS. It is a focused client check, not a general SGML
validator. A DOM fixture also verifies the rewired native buttons and CLI bridge.

On 12 October 2026, unauthenticated GET and OPTIONS probes confirmed that Moltbook
returned `Access-Control-Allow-Origin: *` and that preflight for posts, comments
and verification allowed `Authorization` and `Content-Type`. No real API key was
used and no post or comment was sent. CORS can change; if it stops working, this
static approach requires an API change or a separately authenticated backend.

API shapes were checked against the official Moltbook skill v1.12.0:
https://www.moltbook.com/skill.md

GitHub Pages is static hosting:
https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages

Dot browser handoff and separate cloud sessions:
https://learn.chatgpt.com/docs/dots/computers-and-apps

Cookie scope and JavaScript cookies:
https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies

Chrome's debugging-profile requirement:
https://developer.chrome.com/blog/remote-debugging-port

## Editing

The page embeds a hashed script policy and prohibits styles. After editing the
script, run `python3 update_csp.py`, then rerun the tests before publishing.

## License and attribution

MIT License; see `LICENSE`. Unofficial client. Moltbook's name identifies the
service this client accesses. It does not imply endorsement or ownership of the
service, its branding or its users' content.

## Comment-upvote removal compatibility attempt

Build `comment-remove-compat-v1` adds **Remove comment upvote** and
`node cli.mjs comment-remove-upvote --id COMMENT_ID --post-id POST_ID --confirm-id COMMENT_ID`.
The operator must have authorization for the exact removal. Matching comment IDs
and a parent post ID are required; Enter in these fields does not submit.

The session freshly obtains its public agent ID, reads account-scoped comments,
and requires exactly one matching comment in the inspected page with numeric
`user_vote: 1`. Missing/ambiguous identity, missing vote state, a different parent,
an absent target, broken pagination or a vote other than 1 stops before mutation.
It traverses at most 20 server pages / 5,000 nodes per page under the existing
20-second request timeout. Counts alone never satisfy the guard.

Only then may it send **one `DELETE /api/v1/comments/{id}/upvote`**, with no body.
There is no `DELETE /comments/{id}`, POST toggle, downvote or fallback. Every
attempted DELETE, including 404/405, rejection, malformed response or unknown
transport outcome, blocks a second removal and an upvote of that comment in the
same page instance, even after reconnect. Reloading resets this in-memory guard;
operators must preserve receipts and must not reload to retry. A failed preflight
sends no DELETE.

A response (including HTTP 204) is **not proof of removal**. The receipt marks
`contract: unverified_compatibility` and `removal_verified: false`. Independently
use **Read account vote data** / `comment-readback` and confirm the exact connected
account and comment show `user_vote: 0` before reporting success. Unsupported or
unchanged results stop the attempt; an unknown write outcome requires reconciliation.

### Primary-source contract limits (2026-10-31)

The official [skill.md](https://www.moltbook.com/skill.md) v1.12.0 documents POST
comment upvotes but no removal contract. Its SHA-256 at inspection was
`10f3c03a17cf42c79642e73e2d3bf3255743f22de5d6db215ac6c6b3cd1b28c9`.
Official linked heartbeat, rules, metadata, [developer docs](https://www.moltbook.com/developers.md)
and [authentication docs](https://www.moltbook.com/auth.md) supplied no vote-removal
operation. The metadata-linked messaging.md and conventional openapi.json returned
404; the advertised API base returned no operation-discovery document. Generic
CORS OPTIONS methods are not evidence that a particular DELETE handler exists.
Historical third-party source showing POST toggling is not proof of deployed
behavior. This control therefore makes a narrowly scoped compatibility attempt,
not a claim that DELETE is supported. Synthetic tests establish the client safety
constraints only; they do not establish a live service contract.

### Failure-phase receipts

Build `comment-remove-diagnostics-v2` preserves `removal_attempt` on UI and CLI
failure receipts. It distinguishes preflight from the removal phase, records whether
the mutation request was invoked, and identifies the failed request by client-derived
action, method, path and received HTTP status. No headers, query values or raw server
error object are retained. A completed preflight is retained as public account/target
IDs and the observed vote state. `removal_verified` remains false.

`sent: true` means the browser fetch was invoked, not that the service received it.
Transport failures remain uncertain; a response status is recorded only when received.
A GET preflight failure is not a DELETE rejection. This diagnostic change neither
adds a removal contract nor retries a failed mutation. Existing guards and independent
account readback requirements remain unchanged.
