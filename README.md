# Comment Link Assistant

WXT-based Chrome Manifest V3 extension for processing a user-supplied queue of
blog or forum URLs. It reads the promoted website's Meta Title and Meta
Description once, generates a distinct contextual comment for each target,
fills and submits the comment form, and checks the result.

## Architecture

The extension calls the selected provider directly. It supports
`deepseek-v4-flash` through DeepSeek's official API and `gemini-3.5-flash`
through KIE's OpenAI-compatible API. No companion server is required.

DeepSeek and KIE keys are stored in `chrome.storage.local`, restricted to
trusted extension contexts. They are sent only to the selected provider and
are never exposed to injected page scripts or written into batch snapshots.

The toolbar action opens a persistent Side Panel. The user reviews the promoted
website metadata and target count, then confirms the whole batch once. The
service worker processes one URL at a time in a reusable inactive tab placed in
a collapsed `Comment Assistant` group. Automated work never activates that tab;
login and CAPTCHA gates pause the queue until the user explicitly opens it.

Before a provider request or page click, the next phase is persisted. A
recovered generation request with an unknown outcome is not repeated, and a
recovered `click_dispatched` item is verified instead of clicked again. An
unconfirmed submission is recorded as terminal and is never automatically
retried. A comment counts as published only when its fingerprint is rendered on
the page and also appears in a credential-free public-page fetch. Explicit
acceptance without a publicly visible comment is recorded as submitted but not
visible, and later targets from that website are skipped. Each website keeps a
timestamped node history and its generated comment in the batch snapshot until
the user starts a new batch.

The dedicated worker tab has a `{ batchId, tabId }` ownership marker in
`chrome.storage.session`. Every read, activation, navigation, and page command
checks that marker. Because session storage is cleared with the browser
session, a persisted tab ID is never trusted after a browser restart.
Completed and stopped batches close the owned worker tab automatically; the
empty Chrome tab group disappears while the Side Panel history remains.

## Development

From this project directory:

```bash
pnpm install
pnpm dev
pnpm test
pnpm typecheck
pnpm build
pnpm zip
```

The production build is written to `.output/chrome-mv3/`. Load that directory
from `chrome://extensions` with Developer mode enabled.

## Permissions

- `storage`: persist public settings, local provider keys, and batch progress.
- `activeTab`: inspect the current tab after a user gesture.
- `scripting`: inject the page analyzer and comment-form operator on demand.
- `alarms`: provide a recovery wake-up if the service worker is suspended.
- `sidePanel`: keep batch controls and progress visible while browsing.
- `tabGroups`: organize the single inactive worker tab in a collapsed group.
- Fixed provider host permissions: call DeepSeek and KIE directly.
- Optional HTTP/HTTPS host permissions: requested at runtime only for the
  promoted website and user-supplied target origins.

The extension has no broad `tabs` permission and no always-on `<all_urls>`
content script.

## Comment-frame support

Comment forms in the page DOM, open shadow DOM, and same-origin iframes are
supported. Third-party cross-origin widgets such as hosted Disqus, Giscus, or
Hyvor frames are reported as `CROSS_ORIGIN_COMMENT_FRAME_UNSUPPORTED` and must
be handled manually.
