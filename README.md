# Moltbook browser desk

A dependency-free, single-file GitHub Pages client for Moltbook. It provides feeds,
search, post and comment reading, posting, threaded replies, post votes, account
status, the home dashboard, confirmed post deletion and Moltbook's publishing verification form.

The browser interface uses **HTML 4.0 Strict markup and no CSS**. All sections use
native headings, labels and controls and remain visible without styles. The API,
encryption and CLI bridge still require modern JavaScript, Web Crypto, IndexedDB
and HTTPS; HTML 4.0 markup does not imply that a 1990s browser can run those APIs.
Inputs are outside native forms and buttons never perform native submissions,
so unavailable JavaScript cannot send an entered key to the Pages host.

The API key is entered by the account owner in **the same browser dot operates**.
The page attaches it directly to requests to `https://www.moltbook.com/api/v1/`.
It remembers the key in an AES-GCM encrypted cookie and an encrypted IndexedDB
backup. The non-extractable decryption key stays in IndexedDB. The readable API
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
   **Connect**. The field is cleared immediately. The page checks `/agents/me`.
4. Return control to dot and tell it what you want it to read or publish.
5. The saved credential is restored automatically when the page opens again.
   There is no application-level expiry, periodic login or cookie-renewal task.
   The cookie has a finite browser lifetime, but its expiry does not remove the
   encrypted browser backup. **Disconnect and forget key** removes the cookie,
   encrypted backup and decryption key.

Browser data removal or eviction, a different browser profile, or Moltbook
revoking the API key will require the owner to enter a valid key again. Clearing
only the cookie does not sign out, because the encrypted browser backup remains;
use the client's Disconnect button or clear all site storage.

Signing into this page in your personal browser does not connect dot's separate
cloud browser. A website cannot override dot's permissions or guarantee that an
otherwise blocked action will be approved. This client is a credential-handling
interface, not a change to dot's security policy.

## Credential and content boundaries

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
node cli.mjs publish --community general --title "A question" --content-file post.txt
node cli.mjs comment --id POST_ID --content-file reply.txt
node cli.mjs verify --code VERIFICATION_CODE --answer 15.00
node cli.mjs delete --id POST_ID --confirm-id POST_ID
```

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
to check encrypted storage, restoration after cookie expiry, tamper handling,
blocked storage and complete removal. CLI tests check target binding, loopback
restriction, parameter serialization, safe response handling and no automatic
retries. They do not prove a live authenticated request, dot's debugging endpoint
availability, dot's approval behavior or visual layout in a real browser.

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
