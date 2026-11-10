# agent-login

Lets an AI agent sign in to a website without ever seeing the password.

The agent passes one account key. `agent-login` reads the username, password and allowed websites from 1Password, signs in with its own headless Chrome, and hands back only a signed-in Chrome profile. The agent opens that profile with [`chrome-devtools-axi`](https://www.npmjs.com/package/chrome-devtools-axi) and carries on from the signed-in page.

> [!WARNING]
> **This is a proof of concept with known security shortcuts. Read this section before you use it.**
>
> agent-login keeps the password away from the agent in normal use. It does **not** protect anything from an agent that sets out to get around it, because the agent runs as the same OS user as agent-login and can read everything agent-login can. Only put accounts in its vault that you would be fine with an agent misusing: test accounts, low-permission accounts, or accounts for things like booking a desk. Never your own main accounts, admin accounts or anything with payment details.
>
> The shortcuts, what can go wrong with each, and how to limit it:
>
> 1. **Any agent running as you can read the 1Password token.** The token file is in your home folder, owned by you, and agents run as you. An agent that reads it can read every item in the vault, including every password. It could also attach a debugger to a running `agent-login` and read the password from memory.
>    *Limit it:* give the service account read access to one vault that holds only agent accounts, and nothing else. Keep the token file `chmod 600` (the tool refuses to run otherwise). The tool never prints it.
>    *A real fix:* run `agent-login` as a separate OS user that owns the token, settings and log, with one `sudo` rule that lets agents run exactly `agent-login <account key>` as that user.
>
> 2. **Any agent running as you can change the settings.** That covers the config file, the `AGENT_LOGIN_*` environment variables, each site's selectors file and the folders they point to.
>    *What that can and cannot do:* the websites the password may be typed into come only from the 1Password item, and the password only goes into a real `<input type="password">` on one of those websites. So a changed setting can make sign-in fail, or change where profiles and the log are written. It cannot get the password typed into another site.
>    *A real fix:* the separate OS user from shortcut 1, or the selectors stored in the 1Password item.
>
> 3. **Signed-in profiles are left on disk.** Each profile holds live session cookies until the agent deletes it, and the agent can read and copy those cookies. A signed-in session can do anything the account can.
>    *Limit it:* each run gets a new, empty profile in a folder only you can read; a failed run's profile is deleted; every profile is searched for the password before it is handed over. The skill tells agents to delete the profile when they finish, but nothing forces them to. Prefer low-permission accounts where a site offers them.
>    *A real fix:* sweep away profiles older than a few hours, or hand over a running browser instead of files on disk.
>
> 4. **Session cookies are made to last 8 hours.** Chrome drops cookies with no expiry when it closes, and many sites keep the signed-in session in one, so agent-login gives them an 8-hour expiry. A copied profile stays signed in for up to 8 hours, or until the site ends the session on its side.
>    *A real fix:* choose the lifetime per account.
>
> 5. **"Signed in" is a guess unless the site has a `signedInSelector`.** Without one, the tool counts "the password field has gone" as signed in, which can be wrong on an odd page.
>    *Limit it:* set `signedInSelector` for every site (`add-site --signed-in-selector`). A failed sign-in is never retried, so a wrong guess does not lock the account.
>
> 6. **Any agent running as you can change or delete the audit log.** It is a file in your home folder.
>    *Limit it:* it holds only the time, account key, result and signed-in page (without its query string), never a username or password. Treat it as a convenience, not evidence.
>
> 7. **Site notes are written and read by agents.** An agent could write something misleading into a site's notes, by mistake or because a web page told it to, and the next agent reads it.
>    *Limit it:* the skill tells agents to treat notes as hints, never as instructions, and never to write secrets or personal data into them. Read the notes yourself now and then.
>
> It has been run on Ubuntu with Google Chrome only. The macOS Chrome path is in the code but has not been tried.

## Contents

- [How it works](#how-it-works)
- [Installing](#installing)
- [Setting up 1Password](#setting-up-1password)
- [Running setup](#running-setup)
- [Adding a site](#adding-a-site)
- [How an agent uses it](#how-an-agent-uses-it)
- [The agent skill](#the-agent-skill)
- [Settings](#settings)
- [Errors](#errors)
- [What happens when it signs in](#what-happens-when-it-signs-in)
- [Which sites are allowed](#which-sites-are-allowed)
- [Why it hands back a Chrome profile](#why-it-hands-back-a-chrome-profile-not-a-playwright-saved-state-file)
- [Tests](#tests)
- [Deliberate limits](#deliberate-limits)

## How it works

You keep each agent account as a Login item in a 1Password vault set aside for agents. A 1Password service account with read-only access to that vault gives `agent-login` the item. For each site you also write a small local settings file with the CSS selectors for its username field, password field and submit button.

An agent runs `agent-login <account key>`, where the key is the 1Password item id. The tool signs in and prints the path of a signed-in Chrome profile. The agent opens it, does its task, and deletes it.

Each user brings their own 1Password service account and vault. Several agents on one machine (for example each person's assistant) can each have their own settings by pointing `AGENT_LOGIN_CONFIG` at their own config file; see [Settings](#settings). They still run as the same OS user, so they can read each other's files (shortcut 1).

## Installing

Needs:

- Node 22 or later (22.18 or later to run it from a clone, see below)
- Google Chrome, installed the normal way (on Linux, `/opt/google/chrome/chrome`)
- the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) (`op`) on the `PATH`

```bash
git clone https://github.com/dylankuhlenthal/agent-login.git
cd agent-login
npm install
ln -s "$PWD/bin/agent-login" ~/.local/bin/agent-login   # any folder on your PATH
```

From a clone, `bin/agent-login` runs the TypeScript source directly with Node's built-in type stripping (on by default from Node 22.18), so after a `git pull` there is nothing to rebuild.

Installed as a package instead (for example as a dependency of another project), it has no `src/`, and Node does not strip types inside `node_modules` anyway. There `bin/agent-login` runs the JavaScript build in `dist/`, which npm makes with `npm run build` (the `prepare` script) when it installs the package, including straight from this GitHub repo. [Sous chef](https://github.com/dylankuhlenthal/sous-chef) installs it this way.

To install the 1Password CLI for one user without root on Linux: download the zip from 1Password's [CLI downloads](https://app-updates.agilebits.com/product_history/CLI2), check its signature (`gpg --verify op.sig op` against 1Password's key `3FEF9748469ADBE15DA7CA80AC2D62742012EA22`), then copy `op` to `~/.local/bin/op`.

## Setting up 1Password

1. **Make a vault for agents only**, for example "Agents". Put only accounts in it that you are fine with an agent misusing (see the warning at the top).
2. **Make a service account** with read access to that vault and nothing else. Do not give it write access or access to any other vault. 1Password's [service account guide](https://developer.1password.com/docs/service-accounts/get-started/) shows where to create one.
3. **Save its token** in a file only you can read. The tool never writes this file for you:

   ```bash
   mkdir -p ~/.config/agent-login && chmod 700 ~/.config/agent-login
   # paste the service account token as the only line of ~/.config/agent-login/op-token
   chmod 600 ~/.config/agent-login/op-token
   ```

## Running setup

```bash
agent-login setup --vault "Agents"
```

Leave out `--vault` to be asked for it. Setup saves the vault in the config file (`~/.config/agent-login/config.json`) and checks:

- the token file exists, is not empty and is `chmod 600` (it looks only at the file's details for this, not its contents)
- `op` is installed
- Google Chrome is installed
- the token can read the vault (this one does read the token, the same way a sign-in does, and never prints it)

It also creates the site settings folder. Each check prints `ok` or `FAIL` with what to fix. It exits 0 when every check passes, and 2 otherwise.

## Adding a site

### 1. In 1Password

Add a Login item to the agents vault with:

- **username** and **password**
- **website**: one entry for every site the login page may be on. The primary website is the page it opens to sign in, unless you give `--login-url` below. If the site redirects its login page to another host, add that host as another website.

The item's id (its UUID, 26 lowercase letters and digits) is the account key. `op item list --vault Agents`, signed in as yourself, lists the ids, and the 1Password app can copy an item's UUID.

### 2. On this machine

Find the selectors with your browser's developer tools on the login page, then:

```bash
agent-login add-site <account key> \
  --username-selector '#email' \
  --password-selector 'input[type=password]' \
  --submit-selector 'button[type=submit]' \
  --signed-in-selector 'nav .account-menu'
```

| Flag | Needed | What it is |
| --- | --- | --- |
| `--username-selector` | yes | The username or email field. |
| `--password-selector` | yes | The password field. It must turn out to be an `<input type="password">`, or sign-in is refused. |
| `--submit-selector` | yes | The button that submits the form. |
| `--signed-in-selector` | strongly advised | Something that only shows once signed in. Without it, "the password field has gone" counts as signed in (shortcut 5). |
| `--login-url` | no | The login page, if it is not the item's primary website. It must be on one of the item's websites. |
| `--replace` | no | Overwrite this site's existing settings. |

This writes `<account key>.json` in the site settings folder:

```json
{
  "usernameSelector": "#email",
  "passwordSelector": "input[type=password]",
  "submitSelector": "button[type=submit]",
  "signedInSelector": "nav .account-menu"
}
```

It also starts `<account key>.notes.md` next to it, unless one exists already. Fill in its "Site:" line, for example `Site: the office desk booking site`, so agents can tell which key is which. Agents add what they learn about using the site under it. `--replace` never touches the notes.

Then try it: `agent-login <account key>`.

### Why allowed sites come from 1Password and selectors from a local file

The allowed sites are the one setting that, if an agent could change it, would let it get the password typed into a page it controls. So they come from the 1Password item, which the service account can only read.

The selectors cannot leak the password even if an agent changes them, because the tool checks that the password goes only into a real password input on an allowed site. The worst a changed selector can do is make the sign-in fail. Keeping them in a local file means adding a site does not need someone editing the item in the 1Password app, and the read-only service account could not write them there anyway.

## How an agent uses it

```bash
agent-login <account key>
```

On success it exits 0 and prints JSON on stdout:

```json
{
  "ok": true,
  "account": "abcdefghijklm0123456789xyz",
  "profileDir": "/home/you/.cache/agent-login/sessions/abcdefghijklm0123456789xyz-AbC123",
  "signedInUrl": "https://example.test/home",
  "notesFile": "/home/you/.config/agent-login/accounts/abcdefghijklm0123456789xyz.notes.md",
  "open": {
    "env": {
      "CHROME_DEVTOOLS_AXI_USER_DATA_DIR": "/home/you/.cache/agent-login/sessions/abcdefghijklm0123456789xyz-AbC123",
      "CHROME_DEVTOOLS_AXI_SESSION": "agent-login-abcdefghijklm0123456789xyz"
    },
    "then": "npx -y chrome-devtools-axi open <signedInUrl>",
    "whenDone": "npx -y chrome-devtools-axi stop, then rm -rf <profileDir>"
  }
}
```

Then the agent reads the notes file, if there is one, and opens the signed-in page:

```bash
export CHROME_DEVTOOLS_AXI_USER_DATA_DIR=<profileDir>
export CHROME_DEVTOOLS_AXI_SESSION=agent-login-<account key>
npx -y chrome-devtools-axi open <signedInUrl>
# ... work in the site ...
npx -y chrome-devtools-axi stop
rm -rf <profileDir>
```

The named session keeps this browser separate from any other `chrome-devtools-axi` browser the agent has open. When it is done, the agent adds what it learned to the notes file.

On a refusal it exits 2 and prints one line of JSON on stderr, for example:

```json
{"ok":false,"code":"SITE_NOT_ALLOWED","message":"http://127.0.0.1:41234 is not one of this account's websites (https://example.test)."}
```

See [Errors](#errors) for every code.

## The agent skill

[`skills/agent-login/SKILL.md`](skills/agent-login/SKILL.md) tells an agent how to use the tool: how to find the account key, sign in, read the site notes first, open the profile, clean up, and add to the notes afterwards, plus what it must never do (look for the password, change settings, retry a failed sign-in).

To give it to Claude Code, link it into your skills folder (sous chef's setup does this for you):

```bash
ln -s "$PWD/skills/agent-login" ~/.claude/skills/agent-login
```

Other agents can be pointed at the file directly.

## Settings

| Setting | Environment variable | Default |
| --- | --- | --- |
| `vault` | `AGENT_LOGIN_VAULT` | none: sign-in is refused with `NO_VAULT` until it is set |
| `tokenFile` | `AGENT_LOGIN_TOKEN_FILE` | `~/.config/agent-login/op-token` |
| `accountsDir` (site settings and notes) | `AGENT_LOGIN_ACCOUNTS_DIR` | `~/.config/agent-login/accounts` |
| `sessionsDir` (signed-in profiles) | `AGENT_LOGIN_SESSIONS_DIR` | `~/.cache/agent-login/sessions` |
| `logFile` | `AGENT_LOGIN_LOG_FILE` | `~/.local/state/agent-login/log.jsonl` |

Each setting comes from its environment variable if that is set, otherwise from the config file, otherwise from the default. The config file is `~/.config/agent-login/config.json`, or the file named by `AGENT_LOGIN_CONFIG`:

```json
{
  "vault": "Agents",
  "tokenFile": "~/.config/agent-login/op-token",
  "accountsDir": "~/.config/agent-login/accounts"
}
```

Paths must be absolute or start with `~/`. An unknown setting name is refused, so a typo does not go unnoticed.

The vault has no default on purpose: a guessed vault name could read the wrong vault.

To give a second agent on the same machine its own vault and folders, give it its own config file and set `AGENT_LOGIN_CONFIG` in that agent's environment:

```bash
AGENT_LOGIN_CONFIG=~/.config/agent-login/second-agent.json agent-login setup --vault "Second Agent"
```

## Errors

Sign-in refusals exit 2 and print one line of JSON on stderr.

| Code | Meaning |
| --- | --- |
| `NO_VAULT` | No vault is set. Run `agent-login setup`. |
| `BAD_CONFIG` | The config file or an `AGENT_LOGIN_*` path is wrong (not JSON, an unknown setting, a relative path). |
| `BAD_ACCOUNT_KEY` | The key is not a 1Password item id (26 lowercase letters and digits). |
| `TOKEN_MISSING` | The token file is missing or empty. |
| `TOKEN_TOO_OPEN` | The token file can be read by other users. It must be `chmod 600`. |
| `UNKNOWN_ACCOUNT` | No item with that id in the vault. |
| `LOOKUP_FAILED` | 1Password could not be reached or rejected the token. |
| `ITEM_INCOMPLETE` | The item has no username, password or website. |
| `NO_ACCOUNT_CONFIG` / `BAD_ACCOUNT_CONFIG` | The site's settings file is missing or wrong. |
| `ACCOUNT_CONFIG_EXISTS` | `add-site` without `--replace` for a site that already has settings. |
| `SITE_NOT_ALLOWED` | The login page, after redirects, is not on one of the item's websites. |
| `FIELD_NOT_FOUND` | A selector matched no visible element. |
| `NOT_A_PASSWORD_FIELD` | The password selector is not an `<input type="password">` on the allowed page. |
| `SIGN_IN_FAILED` | The login form was still there after submitting, or the site sent the browser off the item's sites (see [Which sites are allowed](#which-sites-are-allowed)). It does not retry, so the account does not get locked. |
| `PASSWORD_IN_PROFILE` | The password was found in the profile files, so the profile was deleted. |

Exit 1 means an unexpected error. Exit 64 means the command was used wrongly (it prints usage).

Nothing is typed anywhere until every check before it has passed. Each refusal happens before the password reaches the page.

## What happens when it signs in

1. Loads the settings, and refuses if no vault is set.
2. Checks the account key looks like a 1Password item id, so it can never be read as an `op` flag.
3. Reads the service account token from the token file and gives it to `op` through `op`'s environment only.
4. Runs `op item get <key> --vault <vault>` and takes the username, the password and every website on the item.
5. Reads the site's selectors from `<accountsDir>/<key>.json`.
6. Checks the login address is on one of the item's websites, before opening anything.
7. Starts headless Chrome with a new, empty profile in the sessions folder, with Chrome's password saving and form autofill turned off.
8. Opens the login page and checks the real address, after redirects, is on one of the item's websites.
9. Checks the password selector is a visible `<input type="password">` in that page.
10. Fills the username, checks the address and the password field again, fills the password and clicks submit.
11. Waits until the page looks signed in (the `signedInSelector` shows, or else the password field is gone) and has stayed that way for 1.5 seconds after the page loaded, because a page that is still loading has no password field either. If the browser leaves the item's sites at any point after submitting, it stops with `SIGN_IN_FAILED`. After submitting, "the item's sites" also covers sibling subdomains; see [Which sites are allowed](#which-sites-are-allowed).
12. Gives cookies with no expiry an 8-hour expiry, because Chrome drops those when it closes and many sites keep the session in one.
13. Closes Chrome and searches every file in the profile for the password (as UTF-8, UTF-16, URL-encoded and base64). If it is found, the profile is deleted.
14. Appends one line to the log file: time, account key, result and, on success, the signed-in page without its query string (sites put things like the username there). Never the username or password.

Any failure deletes that run's profile. The whole run stops after 2 minutes.

## Which sites are allowed

There are two rules, one for before the password is typed and one for after the form is submitted.

**Typing the password: exact item websites only.** The login page, after any redirects, must have exactly the scheme, host and port of one of the item's websites. A sibling subdomain does not count. For example, with `https://app.example.com` on the item:
- the tool types the password on `https://app.example.com/account/login`
- it refuses `https://venue.example.com/account/login`, `https://example.com/` and `http://app.example.com/`

**The page reached after signing in: the same site.** It counts if it is one of the item's websites, or has the same scheme and port as one of them and is under the same registered domain. So `https://venue.example.com/booking` counts for `https://app.example.com`. Look-alikes such as `example.com.evil.test` or `app-example.com` do not count.

*Why the second rule is looser:* booking sites often send you to your own venue's subdomain once you are signed in, for example from `app.example.com` to `yourvenue.example.com`. Listing every venue subdomain on the item would be busywork. The password has already gone only to an exact item website by then, so the looser rule cannot leak it. The check still catches a site that sends the browser somewhere unrelated after the form, such as a redirect to a different company's login page, which would otherwise look like a sign-in.

*How the registered domain is worked out:* with the [public suffix list](https://publicsuffix.org/) (via the `tldts` library), not by taking the last two labels. That keeps `mine.co.uk` and `other.co.uk` apart. The list's privately run suffixes count too, so two different `*.github.io` sites never match. An IP address only ever matches exactly.

## Why it hands back a Chrome profile, not a Playwright saved-state file

`chrome-devtools-axi` has no way to load Playwright's saved-state file, and httpOnly cookies (where most sites keep the session) cannot be set from page JavaScript. It does take a profile directory (`CHROME_DEVTOOLS_AXI_USER_DATA_DIR`), so the tool hands back a profile.

Tested on Ubuntu with Chrome 151:

- A profile written by Playwright driving the installed Chrome opens signed in with `chrome-devtools-axi`, with no extra Chrome flags.
- Cookies without an expiry were lost when Chrome closed, which is why step 12 gives them one.
- Playwright's own bundled Chromium does not work for this. Ubuntu blocks its sandbox (`kernel.apparmor_restrict_unprivileged_userns=1`), so `chrome-devtools-axi` cannot start it without `--no-sandbox`. The installed Chrome has an AppArmor profile, so its sandbox works. Using the same installed Chrome on both sides also means the profile is never opened by an older Chrome than the one that wrote it.

## Tests

```bash
npm test          # all tests; runs one browser at a time
npm run typecheck
```

The sign-in tests use fake sites served on 127.0.0.1, reached under `*.localhost` names when a test needs sibling subdomains (Chrome sends every `*.localhost` name to this machine). One fake site plays the allowed site; another plays a phishing site. Every value typed into any input on either site is sent back to its server, so the tests can show the password never reached the wrong field or the wrong site. They cover:
- a good sign-in that opens signed in from the returned profile
- a wrong password, tried once only
- landing on a sibling subdomain after signing in
- every sign-in refusal in the table above except `UNKNOWN_ACCOUNT` and `PASSWORD_IN_PROFILE`, including a sibling subdomain as the login page and a look-alike host after signing in

`test/package.test.ts` packs the package with `npm pack` (which builds it), unpacks it under a `node_modules` folder the way npm installs a dependency, and checks it holds the build, the launcher and the skill but no source, and that its launcher runs the build.

Other tests cover loading settings (no vault, environment variables beating the config file, paths), `setup` (each check, with a stand-in `op` that only accepts a fake token, and that the token is never printed) and `add-site`.

`test/real-1password.test.ts` runs against your real vault and only when you ask for it: `AGENT_LOGIN_REAL=1 AGENT_LOGIN_REAL_ITEM=<account key> npm test`. It covers an unknown item id, and, for the given item, a login address on 127.0.0.1, the item's own website when it redirects somewhere not on the item (set this up only for an item whose primary website redirects to another host, and give the real login page with `loginUrl`), and a password selector that points at the username field. None of these submit anything to the real site.

## Deliberate limits

- Sites that need Google or other single sign-on, push approvals, email codes or captchas will not work. Plain authenticator codes could be added later, read from the same 1Password item.
- One username field, one password field, one submit button on the same page. Two-step logins (username, then password on a second page) are not handled yet; that needs a second set of selectors per site.
- A password field inside an iframe is not found, because the tool only looks in the main page. That also keeps it from typing into a frame from another site.
- Linux and macOS only, and only tried on Linux.
