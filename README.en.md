# dsh-secret-card

> npm package `dsh-secret-card` · Source & issues: <https://github.com/dacenss/dsh-secret-card> · MIT · **中文说明见 [README.md](./README.md)**
>
> ![npm version](https://img.shields.io/npm/v/dsh-secret-card.svg) ![downloads](https://img.shields.io/npm/dm/dsh-secret-card.svg) ![license](https://img.shields.io/npm/l/dsh-secret-card.svg)

A dsh plugin · **secure card for entering secrets**.

The usual way to hand an AI a secret (API Key / Token / password / Webhook secret) during
configuration is to paste it into the chat — where it stays in the conversation record
forever. This plugin takes a different route: **the AI only describes where the secret
should go; the user types it straight into a pop-up card; the plugin writes it into the
config file. The AI never sees the plaintext and only gets two answers back: "did it get
written" and "does it work".**

## Install

Go to the dsh profile directory and install with the pnpm that ships with DSH:

```powershell
cd $env:USERPROFILE\.dsh\profiles\<profile name, usually desktop>
pnpm add dsh-secret-card
```

Then append `dsh-secret-card` to the `dsh.profile.bundles` array in that profile's
`package.json`, and restart DSH.

> Not sure what your profile is called? Look at which directories exist under
> `$env:USERPROFILE\.dsh\profiles\`. If you have the plugin marketplace installed you
> can also add it straight from the UI.

`cordis.patch.yml` inserts the plugin into the roster, and the client bundle
`client/bundle.js` ships pre-built with the npm package — nothing to compile after
installing.

## What it fixes

| Before | With this plugin |
| --- | --- |
| "Send me the API Key" → secret lives in the chat | AI says "please type it in the card that popped up" → secret lands in the file, never in the chat |
| AI reads the config file to "check it wrote correctly" → secret re-enters the model context | AI only gets a redacted result, no secret inside |
| Testing whether a key works means sending it to a third party → into the context again | The plugin carries the secret to the validation endpoint and only reports "valid / not valid" |

## Security statement

**The secret is typed by the user into a card on their own machine and written straight into the config file by the plugin. The AI never sees the plaintext, and the secret never passes through any third-party server.**

- The only time the secret crosses a wire is a same-origin request from the page to the local host (`POST /api/dsh-secret-card/fill`) — it never leaves the machine.
- A secret appearing in tool arguments, messages, file names or shell commands is rejected outright — forbidden at the system-prompt layer, blocked again in code.
- When validating whether a secret works, the plugin carries the secret to the endpoint and hands the AI back only "valid / not valid" — response bodies, response headers and command output are never forwarded.

### Boundaries: what it cannot do

- **The AI can still read the config file afterwards and see the plaintext.** This is a prompt-layer constraint (the system prompt forbids it and the result carries a note); the protocol layer cannot physically prevent it. Protect sensitive files further with file permissions or an encrypted volume.
- Backup files `<file>.bak-YYYYMMDD-HHmmssSSS` are as sensitive as the original — clean them up too.
- `fingerprint` is just the first 8 hex characters of the written value's hash, for eyeballing a match. It cannot be reversed into the secret.

### Where the secret cannot show up (item by item)

- Conversation record / messages — the secret appears in no message; both the tool return value and `output.render` are redacted
- `ctx.logger` — logs only requestId / file / key / status; a unit test asserts the serialized log contains no secret
- SSE broadcast — a fixed field whitelist, asserted secret-free before sending
- HTTP response body — `/fill` returns only status / validation, never echoes
- Process list — for command validation, `%%SECRET%%` is only allowed on stdin; showing up in argv is rejected

### Reporting security issues

Please report security issues through [GitHub Issues](https://github.com/dacenss/dsh-secret-card/issues) and **never paste a plaintext secret into a public issue**.

## How it works

```
AI calls secret_card(file, key, format, label, hint, validation?)
   │  no secret content in the arguments
   ▼
Host mints a requestId and pushes it over SSE
   ▼
A card appears above the composer in the conversation column ← user types the secret
   │  POST /api/dsh-secret-card/fill {requestId, secret}   ← the one and only trip across the wire (same origin)
   ▼
Host: writes the config file (back up first, temp file + rename for an atomic write, then read back and verify)
   │  optional: validate by calling an endpoint with the secret / running a command that receives it on stdin
   ▼
resolve pending → tool returns redacted JSON → AI sees
{status, validation, validationDetail, file, key, backup, fingerprint, note}
```

## Supported write formats (line-level replacement, keeps comments and style)

| Format | Written as |
| --- | --- |
| `.env` / `.env.*` | `KEY=value` (only values with whitespace or a quote, dollar, hash, backtick or backslash become `KEY="value"` with escaping) |
| `.json` | `"KEY": "value"` (no parse/stringify — comments, key order, indentation and trailing commas stay as they were) |
| `.yaml` / `.yml` | `KEY: value` (values with special characters become the quoted form `KEY: "value"`) |
| `.toml` | `KEY = "value"` |

- Key already present → overwritten (`overwrite:false` rejects with `key_exists`)
- Key absent → appended at the end of the file / inserted after the last top-level key in JSON
- **Top-level keys only.** The target file must already exist, and its suffix must be in the allowlist (default `.env env .json .yaml .yml .toml`)

### How a reader recovers the real value

The `quoted` field in the write result says whether this write added quotes; the "On-disk form" row in the rendered table spells it out too:

- `quoted:false` — the file holds `KEY=value` as-is; take whatever follows the `=`
- `quoted:true` — the file holds `KEY="value"`; strip the surrounding double quotes, then unescape `\\` → `\`, `\"` → `"`, `\r` → CR, `\n` → newline

## Optional "does it work" validation

The `validation` argument is a JSON string, and `%%SECRET%%` is the only placeholder (the familiar brace-delimited form is avoided because the host's system-prompt template reads paired braces as a variable reference and fails to register the whole section):

```jsonc
// HTTP validation (recommended)
{"kind":"http","method":"GET","url":"https://api.example.com/v1/verify",
 "header":{"Authorization":"Bearer %%SECRET%%"},"expectStatus":200,"expectBodyContains":"ok"}

// Command validation (off by default, enable it in settings)
{"kind":"command","argv":["npm","run","check"],"stdinTemplate":"%%SECRET%%\n"}
```

The AI only gets `passed / failed / skipped` plus a one-line reason (like `http 403`,
`exit 0`, `denied_host`). **Response bodies, response headers and command output are
never forwarded.**

SSRF guard rails: http/https only; redirects are not followed; a target host that hits
the denylist (this machine, private networks, cloud metadata addresses — default
`localhost 127.0.0.1 ::1 0.0.0.0 169.254.169.254 metadata.google.internal`, editable in
settings) is refused outright.

## Constraints given to the model (auto-injected system prompt)

The plugin injects a `ctx.systemPrompt.section` that requires calling `secret_card`
whenever a secret is needed, forbids putting secrets into arguments / messages / file
names / shell commands, forbids asking the user to paste a secret into the chat, forbids
reading back the value that was just written, and allows only one secret at a time
(`busy` means "there is still a card open").

## Settings (changeable on the settings page)

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | When off, the tool returns `disabled` |
| `timeoutMs` | `180000` | How long the card waits for input before returning `timeout` |
| `backup` | `true` | Back up the file before writing |
| `backupKeep` | `3` | How many backups to keep for the same file |
| `allowedSuffixes` | see above | Allowlist of writable file suffixes |
| `allowCommandValidation` | `false` | Whether the AI may supply a validation command |
| `denyHosts` | see above | Hosts HTTP validation may not reach |

## Tool result contract

```json
{
  "status": "written | already-written | cancelled | timeout | aborted | busy | failed",
  "reason": "… (only for failed/busy)",
  "validation": "passed | failed | skipped",
  "validationDetail": "http 204",
  "file": "C:\\proj\\.env",
  "key": "OPENAI_API_KEY",
  "backup": ".env.bak-20261007-073004821",
  "fingerprint": "sha256:1a2b3c4d",
  "note": "The secret was typed by the user directly into the card and written to the file. This result contains no plaintext — do not read that file's value either."
}
```

## Where the card sits and how you get reminded

- The card docks **right above the composer inside the conversation column** (the host's
  `conversation.input.dock` / `conversation.composer` slots), sharing the same geometry and
  corner radius as the built-in question card. While it is open the composer steps aside;
  collapsing it leaves only the title.
- The moment a card arrives it registers a "pending interaction" with the host
  (`ctx.uiSession.registerPendingInteraction`, kind `question`): the session list lights up a
  warning dot and whatever reminder plugin you have installed fires too. **Registering is
  independent of whether the card is visible** — if you are not on the conversation page and
  the card is queued, the dot and the reminder still show up.
- Closing the card, a successful write, or a host-side cancel retracts the registration
  immediately, so no zombie dots are left behind.
- If the host has none of those slots the card falls back to docking at the bottom of the
  page, and it never hijacks a non-conversation page.

## Known limits

- Top-level keys only; deep paths in nested JSON/YAML need a later version.
- The card is a singleton: one secret at a time, repeat requests merge into the same card.

## Local development

The client is plain DOM with no React, so the build script just embeds the source
verbatim into the `window.__ModuleLoader__.load({ id, factory })` shell.

```bash
npm run check           # node --check on the host and client sources
npm run build:client    # client/index.js → client/bundle.js
npm test                # 41 unit + 8 integration + 1 copy guard (50 total)
```

If you install the source with a `file:` reference, changes must be mirrored manually
(pnpm will not re-copy an already-installed file dependency), then restart DSH:

```powershell
npm run build:client
pwsh scripts\install-local.ps1              # syncs into the desktop profile by default
pwsh scripts\install-local.ps1 -Profile web # other profiles via -Profile
```

The script derives the workspace and profile directories from its own location and
hard-codes no path.

**One red line when editing text meant for the model:** never write a pair of
consecutive braces around a name (two left braces, the name, two right braces). The
host's system-prompt template reads that as a variable reference, and an upper-case
variable name makes the whole section fail to register — the run dies with
`malformed prompt variable reference`. The secret placeholder therefore uses
`%%SECRET%%`, and `test/copy-guard.test.mjs` holds the line with a regression assertion.
