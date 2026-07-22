/** Bridge configuration, read from environment (see .env.example). Each
 *  adapter is enabled only when its variables are present, so the bridge runs
 *  fine with just one source configured. */

export interface YoutubeConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Optional explicit video id; otherwise the active broadcast is discovered. */
  videoId: string | null;
  /** Chat text starting with this triggers a cheer boost ("" disables chat,
   *  "*" forwards every chat line — spammy). Super Chat is always forwarded. */
  chatTrigger: string;
}

export interface AlertboxConfig {
  alertboxUrl: string;
}

export interface BridgeConfig {
  port: number;
  /** If set, POST /webhook must send this in the `x-bridge-secret` header. */
  webhookSecret: string | null;
  youtube: YoutubeConfig | null;
  twip: AlertboxConfig | null;
  toonation: AlertboxConfig | null;
}

function trimmed(v: string | undefined): string {
  return (v ?? "").trim();
}

export function loadConfig(env: NodeJS.ProcessEnv): BridgeConfig {
  const ytId = trimmed(env.YT_CLIENT_ID);
  const ytSecret = trimmed(env.YT_CLIENT_SECRET);
  const ytRefresh = trimmed(env.YT_REFRESH_TOKEN);
  const youtube: YoutubeConfig | null =
    ytId && ytSecret && ytRefresh
      ? {
          clientId: ytId,
          clientSecret: ytSecret,
          refreshToken: ytRefresh,
          videoId: trimmed(env.YT_VIDEO_ID) || null,
          chatTrigger: trimmed(env.YT_CHAT_TRIGGER) || "!build",
        }
      : null;

  const twipUrl = trimmed(env.TWIP_ALERTBOX_URL);
  const toonUrl = trimmed(env.TOONATION_ALERTBOX_URL);

  return {
    port: Number(trimmed(env.STREAM_BRIDGE_PORT)) || 8083,
    webhookSecret: trimmed(env.WEBHOOK_SECRET) || null,
    youtube,
    twip: twipUrl ? { alertboxUrl: twipUrl } : null,
    toonation: toonUrl ? { alertboxUrl: toonUrl } : null,
  };
}
