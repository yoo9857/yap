# @robo/stream-bridge

Bridges live-stream events into **Robo Builder**. It listens to YouTube live
chat / Super Chat and the Korean donation platforms **Toonation** and **Twip**,
normalizes each into one `StreamEvent` shape (defined in `@robo/shared`), and
pushes it over a local WebSocket. The game reacts: a donation/cheer temporarily
**speeds up the whole build crew** (more deliveries, more gold, more confetti)
and shows an on-screen shout-out.

```
YouTube / Toonation / Twip / webhook  ──►  bridge (:8083)  ──WS──►  Robo Builder (?stream=1)
```

## Quick start

```bash
pnpm install
cp apps/stream-bridge/.env.example apps/stream-bridge/.env   # fill in what you use
cd apps/stream-bridge && pnpm start
```

Then open the game with the stream flag:

```
https://craftyap.com/?mode=builder&stream=1                  # bridge runs locally on :8083
http://localhost:5173/?mode=builder&stream=1&streamPort=8083 # dev, custom port
?mode=builder&stream=1&streamUrl=ws://192.168.0.10:8083       # bridge on another machine
```

The bridge is a **local process** — the game always connects to
`ws://localhost:8083` by default (browsers allow `ws://localhost` even from the
https site). Keep the bridge running on the same PC as your browser.

### Test without any keys

In the game's browser console (works even on the live site):

```js
__roboBuilderStream.donate(10000, "Nickname", "Go go go!") // big boost + confetti
__roboBuilderStream.chat("Viewer", "hi")                    // small cheer
__roboBuilderStream.status()                                // { connected, boostMult, ... }
```

Or hit the webhook (drives the real WS path end-to-end):

```bash
curl -X POST localhost:8083/webhook -H 'content-type: application/json' \
  -d '{"kind":"donation","name":"Tester","message":"nice","amount":5000,"currency":"KRW"}'
```

## Sources

### YouTube (chat + Super Chat)
Reading your channel's own live chat needs OAuth (not just an API key):

1. Google Cloud Console → new project → enable **YouTube Data API v3**.
2. Create an **OAuth client ID** (application type *Desktop*). Copy the client id/secret.
3. Do the one-time consent to get a **refresh token** (scope
   `youtube.readonly`) — the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
   is the easiest: gear icon → *Use your own OAuth credentials* → authorize the
   YouTube Data API v3 scope → exchange for tokens → copy the refresh token.
4. Put `YT_CLIENT_ID` / `YT_CLIENT_SECRET` / `YT_REFRESH_TOKEN` in `.env`.

Super Chat / Super Sticker always fire a donation boost. Plain chat fires a
cheer only when it starts with `YT_CHAT_TRIGGER` (default `!build`; set `*` to
react to every line, `""` to ignore chat). The API has a daily quota — the
bridge honors the poll interval the API returns, which is fine for a normal
broadcast.

### Toonation / Twip
Neither has a public API, so the adapters follow the community
reverse-engineered flow: the bridge scrapes your **alert box URL** for its
connection token, then subscribes to the donation socket. Paste the alert box
URL from your dashboard into `TOONATION_ALERTBOX_URL` / `TWIP_ALERTBOX_URL`.

> These socket formats are unofficial and occasionally change. If a real
> donation logs `donation with no parseable amount: …`, copy that logged
> payload — the field mapping in `adapters/toonation.ts` / `adapters/twip.ts`
> just needs the actual key names.

### Generic webhook
`POST /webhook` with `{ kind, name, message, amount, currency }` (or
`amountKrw` directly). Any platform that can fire an HTTP request (Streamlabs,
StreamElements, a custom OBS setup, Zapier…) can drive the game this way. Set
`WEBHOOK_SECRET` to require an `x-bridge-secret` header.

## Boost tuning
All tiers live in one pure function — `streamBoost()` in
`packages/shared/src/stream.ts` — so they're unit-tested and identical
everywhere. Edit there to retune (amount → multiplier/duration).
