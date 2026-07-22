/**
 * One-time YouTube OAuth helper for a **Desktop** OAuth client.
 *
 * Runs the standard installed-app loopback flow (no OAuth Playground needed):
 * spins up a throwaway server on 127.0.0.1, opens Google's consent screen,
 * captures the redirect, exchanges the code for a refresh token using YOUR
 * client id/secret, and writes YT_REFRESH_TOKEN back into .env.
 *
 *   cd apps/stream-bridge && pnpm auth
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env");
} catch {
  /* no .env yet */
}

const clientId = (process.env.YT_CLIENT_ID ?? "").trim();
const clientSecret = (process.env.YT_CLIENT_SECRET ?? "").trim();
if (!clientId || !clientSecret) {
  console.error("✗ Set YT_CLIENT_ID and YT_CLIENT_SECRET in apps/stream-bridge/.env first.");
  process.exit(1);
}

const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
let redirectUri = "";

const server = createServer((req, res) => void handleRedirect(req, res));

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  redirectUri = `http://127.0.0.1:${port}`;
  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
    }).toString();

  console.log("\nOpen this URL in your browser (the channel's Google account):\n");
  console.log("  " + authUrl + "\n");
  console.log('If you see "Google hasn\'t verified this app", click Advanced → Go to (app).\n');
  tryOpen(authUrl);
});

async function handleRedirect(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (err) {
    reply(res, `Authorization failed: ${err}`);
    return;
  }
  if (!code) {
    res.writeHead(204);
    res.end();
    return; // favicon etc.
  }
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const json = (await tokenRes.json()) as { refresh_token?: string; error_description?: string };
    if (!tokenRes.ok || !json.refresh_token) {
      throw new Error(json.error_description ?? JSON.stringify(json));
    }
    saveRefreshToken(json.refresh_token);
    reply(res, "✓ Done! Refresh token saved to .env. You can close this tab and return to the terminal.");
    console.log("\n✓ Refresh token obtained and written to apps/stream-bridge/.env\n");
    console.log("  " + json.refresh_token + "\n");
    console.log("Now start the bridge:  pnpm start\n");
    setTimeout(() => process.exit(0), 300);
  } catch (e) {
    reply(res, "Token exchange failed — see terminal.");
    console.error("\n✗ Token exchange failed:", (e as Error).message, "\n");
    setTimeout(() => process.exit(1), 300);
  }
}

function saveRefreshToken(token: string): void {
  const path = ".env";
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (/^YT_REFRESH_TOKEN=.*$/m.test(text)) {
    text = text.replace(/^YT_REFRESH_TOKEN=.*$/m, `YT_REFRESH_TOKEN=${token}`);
  } else {
    text += `${text.endsWith("\n") || text === "" ? "" : "\n"}YT_REFRESH_TOKEN=${token}\n`;
  }
  writeFileSync(path, text);
}

function reply(res: ServerResponse, msg: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px sans-serif;padding:40px">${msg}</body>`);
}

/** Best-effort browser open; harmless if it fails (URL is printed anyway). */
function tryOpen(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("powershell", ["-NoProfile", "-Command", "Start-Process", url], { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore" });
    } else {
      spawn("xdg-open", [url], { stdio: "ignore" });
    }
  } catch {
    /* user opens the printed URL manually */
  }
}
