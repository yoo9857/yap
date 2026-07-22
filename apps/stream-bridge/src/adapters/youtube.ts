import type { StreamEvent } from "@robo/shared";
import type { YoutubeConfig } from "../config.js";
import { makeEvent, toKrw } from "../normalize.js";

/**
 * YouTube live-chat adapter. Refreshes an OAuth access token, finds the
 * channel's active live chat, then polls `liveChatMessages.list` at the
 * interval the API dictates. Super Chat / Super Sticker become donations
 * (amount from `amountMicros` + currency); plain chat becomes a cheer only
 * when it starts with the configured trigger word (default `!build`).
 *
 * Requires OAuth (client id/secret + a refresh token for the broadcasting
 * channel) — reading a channel's own live chat is not an API-key operation.
 */
const OAUTH_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

export class YoutubeAdapter {
  private token: TokenState | null = null;
  private stopped = false;
  private readonly startedAt = Date.now();

  constructor(
    private readonly cfg: YoutubeConfig,
    private readonly onEvent: (e: StreamEvent) => void,
  ) {}

  async start(): Promise<void> {
    try {
      const liveChatId = await this.findLiveChatId();
      if (!liveChatId) {
        console.warn("[youtube] no active broadcast found — set YT_VIDEO_ID or go live, then restart");
        return;
      }
      console.info(`[youtube] connected to live chat ${liveChatId}`);
      void this.poll(liveChatId, undefined);
    } catch (err) {
      console.error("[youtube] failed to start:", (err as Error).message);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 30_000) return this.token.accessToken;
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      refresh_token: this.cfg.refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch(OAUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`token refresh ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return this.token.accessToken;
  }

  private async api<T>(path: string): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(`${API}/${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  private async findLiveChatId(): Promise<string | null> {
    if (this.cfg.videoId) {
      const data = await this.api<{
        items: { liveStreamingDetails?: { activeLiveChatId?: string } }[];
      }>(`videos?part=liveStreamingDetails&id=${encodeURIComponent(this.cfg.videoId)}`);
      return data.items[0]?.liveStreamingDetails?.activeLiveChatId ?? null;
    }
    const data = await this.api<{
      items: { snippet?: { liveChatId?: string } }[];
    }>(`liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all`);
    return data.items[0]?.snippet?.liveChatId ?? null;
  }

  private async poll(liveChatId: string, pageToken: string | undefined): Promise<void> {
    if (this.stopped) return;
    let nextDelay = 5_000;
    try {
      const params = new URLSearchParams({
        liveChatId,
        part: "snippet,authorDetails",
        maxResults: "200",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await this.api<LiveChatResponse>(`liveChatMessages?${params.toString()}`);
      nextDelay = Math.max(2_000, data.pollingIntervalMillis || 5_000);
      pageToken = data.nextPageToken;
      for (const item of data.items ?? []) this.handleItem(item);
    } catch (err) {
      console.warn("[youtube] poll error:", (err as Error).message);
      nextDelay = 10_000;
    }
    if (!this.stopped) setTimeout(() => void this.poll(liveChatId, pageToken), nextDelay);
  }

  private handleItem(item: LiveChatItem): void {
    // skip the backlog delivered on the first poll — only react to messages
    // that arrive after the bridge started
    const published = Date.parse(item.snippet.publishedAt ?? "");
    if (Number.isFinite(published) && published < this.startedAt) return;

    const name = item.authorDetails?.displayName ?? "";
    const id = item.id;
    const sc = item.snippet.superChatDetails ?? item.snippet.superStickerDetails;
    if (sc) {
      const amount = Number(sc.amountMicros ?? "0") / 1_000_000;
      const currency = sc.currency ?? "KRW";
      this.onEvent(
        makeEvent({
          source: "youtube",
          kind: "donation",
          name,
          message: sc.userComment ?? "",
          amountKrw: toKrw(amount, currency),
          display:
            sc.amountDisplayString ?? `${amount} ${currency}`,
          id,
        }),
      );
      return;
    }

    if (item.snippet.type === "textMessageEvent") {
      const text = item.snippet.textMessageDetails?.messageText ?? "";
      const trigger = this.cfg.chatTrigger;
      if (!trigger) return; // chat disabled
      if (trigger !== "*" && !text.toLowerCase().startsWith(trigger.toLowerCase())) return;
      this.onEvent(
        makeEvent({ source: "youtube", kind: "chat", name, message: text, id }),
      );
    }
  }
}

interface LiveChatResponse {
  pollingIntervalMillis: number;
  nextPageToken?: string;
  items?: LiveChatItem[];
}

interface SuperChatDetails {
  amountMicros?: string;
  currency?: string;
  amountDisplayString?: string;
  userComment?: string;
}

interface LiveChatItem {
  id: string;
  snippet: {
    type: string;
    publishedAt?: string;
    superChatDetails?: SuperChatDetails;
    superStickerDetails?: SuperChatDetails;
    textMessageDetails?: { messageText?: string };
  };
  authorDetails?: { displayName?: string };
}
