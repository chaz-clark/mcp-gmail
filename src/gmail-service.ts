import { google, gmail_v1 } from "googleapis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  labelIds: string[];
}

export interface EmailDetail {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  body: string;
  labelIds: string[];
  headers: Record<string, string>;
  unsubscribeLinks: string[];
}

export interface UnsubscribeResult {
  success: boolean;
  method: "header-mailto" | "header-http" | "body-link" | "none";
  detail: string;
}

export interface SendResult {
  success: boolean;
  messageId: string;
  threadId: string;
}

export interface DraftResult {
  success: boolean;
  draftId: string;
  messageId: string;
  threadId: string;
}

export interface ComposeOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** When set, the new message will thread with this Gmail message (sets In-Reply-To + References + threadId). */
  inReplyToMessageId?: string;
}

// ---------------------------------------------------------------------------
// Gmail Service — one instance per access token (per session)
// ---------------------------------------------------------------------------

export class GmailService {
  private gmail: gmail_v1.Gmail;

  constructor(accessToken: string) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    this.gmail = google.gmail({ version: "v1", auth });
  }

  // -----------------------------------------------------------------------
  // list_emails
  // -----------------------------------------------------------------------

  async listEmails(
    query?: string,
    maxResults: number = 20
  ): Promise<EmailSummary[]> {
    const res = await this.gmail.users.messages.list({
      userId: "me",
      q: query || undefined,
      maxResults: Math.min(maxResults, 100),
    });

    const messageIds = res.data.messages ?? [];
    if (messageIds.length === 0) return [];

    // Fetch headers for each message in parallel (batched)
    const summaries = await Promise.all(
      messageIds.map((m) => this.getEmailSummary(m.id!))
    );

    return summaries;
  }

  private async getEmailSummary(messageId: string): Promise<EmailSummary> {
    const res = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["Subject", "From", "Date"],
    });

    const headers = res.data.payload?.headers ?? [];
    const hdr = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value ?? "";

    return {
      id: res.data.id!,
      threadId: res.data.threadId!,
      subject: hdr("Subject"),
      from: hdr("From"),
      date: hdr("Date"),
      snippet: res.data.snippet ?? "",
      labelIds: res.data.labelIds ?? [],
    };
  }

  // -----------------------------------------------------------------------
  // get_email
  // -----------------------------------------------------------------------

  async getEmail(messageId: string): Promise<EmailDetail> {
    const res = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const headers = res.data.payload?.headers ?? [];
    const hdr = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value ?? "";

    const headersMap: Record<string, string> = {};
    for (const h of headers) {
      if (h.name && h.value) headersMap[h.name] = h.value;
    }

    const body = this.extractBody(res.data.payload ?? {});
    const unsubscribeLinks = this.parseUnsubscribeLinks(headersMap, body);

    return {
      id: res.data.id!,
      threadId: res.data.threadId!,
      subject: hdr("Subject"),
      from: hdr("From"),
      to: hdr("To"),
      date: hdr("Date"),
      snippet: res.data.snippet ?? "",
      body,
      labelIds: res.data.labelIds ?? [],
      headers: headersMap,
      unsubscribeLinks,
    };
  }

  // -----------------------------------------------------------------------
  // archive_email — remove INBOX label
  // -----------------------------------------------------------------------

  async archiveEmail(messageId: string): Promise<{ success: boolean }> {
    await this.gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        removeLabelIds: ["INBOX"],
      },
    });
    return { success: true };
  }

  // -----------------------------------------------------------------------
  // apply_label — create if needed, then apply
  // -----------------------------------------------------------------------

  async applyLabel(
    messageId: string,
    labelName: string
  ): Promise<{ success: boolean; labelId: string }> {
    const labelId = await this.getOrCreateLabel(labelName);

    await this.gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: [labelId],
      },
    });

    return { success: true, labelId };
  }

  private async getOrCreateLabel(labelName: string): Promise<string> {
    // Check existing labels
    const res = await this.gmail.users.labels.list({ userId: "me" });
    const existing = (res.data.labels ?? []).find(
      (l) => l.name?.toLowerCase() === labelName.toLowerCase()
    );
    if (existing) return existing.id!;

    // Create new label
    const created = await this.gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: labelName,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    return created.data.id!;
  }

  // -----------------------------------------------------------------------
  // unsubscribe_email
  // -----------------------------------------------------------------------

  async unsubscribeEmail(messageId: string): Promise<UnsubscribeResult> {
    const email = await this.getEmail(messageId);
    const listUnsubscribe = email.headers["List-Unsubscribe"] ?? "";

    // 1. Try HTTP link from List-Unsubscribe header
    const httpLinks = this.extractHttpLinks(listUnsubscribe);
    for (const link of httpLinks) {
      try {
        const resp = await fetch(link, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          return {
            success: true,
            method: "header-http",
            detail: `Successfully requested unsubscribe via header link: ${link}`,
          };
        }
      } catch {
        // Try next link
      }
    }

    // 2. Try POST to List-Unsubscribe with List-Unsubscribe-Post header
    const postHeader = email.headers["List-Unsubscribe-Post"];
    if (postHeader && httpLinks.length > 0) {
      for (const link of httpLinks) {
        try {
          const resp = await fetch(link, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: postHeader,
            redirect: "follow",
            signal: AbortSignal.timeout(10000),
          });
          if (resp.ok) {
            return {
              success: true,
              method: "header-http",
              detail: `Successfully POSTed unsubscribe via RFC 8058: ${link}`,
            };
          }
        } catch {
          // Try next
        }
      }
    }

    // 3. Try mailto from List-Unsubscribe header
    const mailtoMatch = listUnsubscribe.match(/mailto:([^>,\s]+)/i);
    if (mailtoMatch) {
      const mailtoAddr = mailtoMatch[1];
      try {
        await this.sendUnsubscribeMail(mailtoAddr);
        return {
          success: true,
          method: "header-mailto",
          detail: `Sent unsubscribe email to ${mailtoAddr}`,
        };
      } catch (err) {
        // Fall through
      }
    }

    // 4. Scan body for unsubscribe links
    const bodyLinks = this.extractUnsubscribeLinksFromBody(email.body);
    for (const link of bodyLinks) {
      try {
        const resp = await fetch(link, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          return {
            success: true,
            method: "body-link",
            detail: `Visited unsubscribe link found in email body: ${link}`,
          };
        }
      } catch {
        // Try next
      }
    }

    // 5. Nothing worked — return the links we found so Claude can inform the user
    const allLinks = [...httpLinks, ...bodyLinks];
    return {
      success: false,
      method: "none",
      detail:
        allLinks.length > 0
          ? `Could not auto-unsubscribe. Found these links the user can try manually:\n${allLinks.join("\n")}`
          : "No unsubscribe mechanism found in this email.",
    };
  }

  private async sendUnsubscribeMail(toAddress: string): Promise<void> {
    // Compose a minimal unsubscribe email
    const raw = Buffer.from(
      [
        `To: ${toAddress}`,
        `Subject: Unsubscribe`,
        `Content-Type: text/plain; charset="UTF-8"`,
        "",
        "Unsubscribe",
      ].join("\r\n")
    )
      .toString("base64url");

    await this.gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
  }

  // -----------------------------------------------------------------------
  // send_email
  // -----------------------------------------------------------------------

  async sendEmail(opts: ComposeOptions): Promise<SendResult> {
    const { raw, threadId } = await this.composeRaw(opts);
    const res = await this.gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        ...(threadId ? { threadId } : {}),
      },
    });
    return {
      success: true,
      messageId: res.data.id!,
      threadId: res.data.threadId!,
    };
  }

  // -----------------------------------------------------------------------
  // save_draft
  // -----------------------------------------------------------------------

  async saveDraft(opts: ComposeOptions): Promise<DraftResult> {
    const { raw, threadId } = await this.composeRaw(opts);
    const res = await this.gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw,
          ...(threadId ? { threadId } : {}),
        },
      },
    });
    return {
      success: true,
      draftId: res.data.id!,
      messageId: res.data.message?.id ?? "",
      threadId: res.data.message?.threadId ?? threadId ?? "",
    };
  }

  // -----------------------------------------------------------------------
  // reply_to_email — send a reply that threads properly
  // -----------------------------------------------------------------------

  async replyToEmail(
    messageId: string,
    body: string,
    replyAll: boolean = false,
    extraCc: string[] = [],
    extraBcc: string[] = [],
    saveDraftOnly: boolean = false
  ): Promise<SendResult | DraftResult> {
    const source = await this.getEmail(messageId);
    const opts = this.buildReplyComposeOptions(source, body, replyAll, extraCc, extraBcc);
    return saveDraftOnly ? this.saveDraft(opts) : this.sendEmail(opts);
  }

  // -----------------------------------------------------------------------
  // Reply helpers
  // -----------------------------------------------------------------------

  private buildReplyComposeOptions(
    source: EmailDetail,
    body: string,
    replyAll: boolean,
    extraCc: string[],
    extraBcc: string[]
  ): ComposeOptions {
    const myAddresses = this.collectSelfAddresses(source);
    const fromAddrs = this.parseAddressList(source.headers["From"] ?? source.from);
    const sourceToAddrs = this.parseAddressList(source.headers["To"] ?? source.to);
    const sourceCcAddrs = this.parseAddressList(source.headers["Cc"] ?? "");

    // Primary reply target: sender of the source (Reply-To beats From).
    const replyTo = this.parseAddressList(source.headers["Reply-To"] ?? "");
    const to = (replyTo.length > 0 ? replyTo : fromAddrs).filter(
      (a) => !myAddresses.has(a.toLowerCase())
    );

    // Reply-all: source's To + Cc minus ourselves and the primary recipient.
    let cc: string[] = [];
    if (replyAll) {
      const seen = new Set<string>(to.map((a) => a.toLowerCase()));
      for (const list of [sourceToAddrs, sourceCcAddrs]) {
        for (const addr of list) {
          const key = addr.toLowerCase();
          if (myAddresses.has(key) || seen.has(key)) continue;
          seen.add(key);
          cc.push(addr);
        }
      }
    }
    cc.push(...extraCc);

    const subject = this.ensureReplyPrefix(source.subject);
    const quoted = this.quoteOriginal(source, body);

    return {
      to,
      cc: cc.length > 0 ? cc : undefined,
      bcc: extraBcc.length > 0 ? extraBcc : undefined,
      subject,
      body: quoted,
      inReplyToMessageId: source.id,
    };
  }

  private ensureReplyPrefix(subject: string): string {
    const trimmed = (subject ?? "").trim();
    return /^re:\s/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
  }

  private quoteOriginal(source: EmailDetail, replyBody: string): string {
    const dateLabel = source.date || "earlier";
    const fromLabel = source.from || "(unknown sender)";
    const sep = `\n\nOn ${dateLabel}, ${fromLabel} wrote:`;
    const quotedBody = (source.body || source.snippet || "")
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n");
    return `${replyBody}\n${sep}\n${quotedBody}`;
  }

  /**
   * Collect addresses that represent "me" on this thread — used to filter
   * ourselves out of reply-all recipient lists. We can't introspect the
   * authenticated user's email from the access token alone (cheaply), so we
   * trust the Delivered-To / X-Original-To headers plus any address in To/Cc
   * that matches the recipient hints downstream. The server's MCP layer also
   * passes through which account we authenticated as via the `account`
   * parameter and could supply that — but here we extract conservatively.
   */
  private collectSelfAddresses(source: EmailDetail): Set<string> {
    const addrs = new Set<string>();
    for (const hdr of ["Delivered-To", "X-Original-To", "X-Forwarded-To"]) {
      const v = source.headers[hdr];
      if (v) for (const a of this.parseAddressList(v)) addrs.add(a.toLowerCase());
    }
    return addrs;
  }

  // -----------------------------------------------------------------------
  // Compose — assemble RFC 822 raw message body
  // -----------------------------------------------------------------------

  private async composeRaw(
    opts: ComposeOptions
  ): Promise<{ raw: string; threadId?: string }> {
    if (!opts.to || opts.to.length === 0) {
      throw new Error("send/draft requires at least one recipient in `to`.");
    }
    if (!opts.subject) {
      throw new Error("send/draft requires a `subject`.");
    }

    const lines: string[] = [];
    lines.push(`To: ${opts.to.join(", ")}`);
    if (opts.cc && opts.cc.length > 0) lines.push(`Cc: ${opts.cc.join(", ")}`);
    if (opts.bcc && opts.bcc.length > 0) lines.push(`Bcc: ${opts.bcc.join(", ")}`);
    lines.push(`Subject: ${opts.subject}`);
    lines.push(`MIME-Version: 1.0`);
    lines.push(`Content-Type: text/plain; charset="UTF-8"`);
    lines.push(`Content-Transfer-Encoding: 7bit`);

    let threadId: string | undefined;
    if (opts.inReplyToMessageId) {
      const src = await this.gmail.users.messages.get({
        userId: "me",
        id: opts.inReplyToMessageId,
        format: "metadata",
        metadataHeaders: ["Message-ID", "References"],
      });
      threadId = src.data.threadId ?? undefined;

      const headers = src.data.payload?.headers ?? [];
      const hdr = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;
      const msgId = hdr("Message-ID");
      const refs = hdr("References");

      if (msgId) lines.push(`In-Reply-To: ${msgId}`);
      if (msgId || refs) {
        const referencesChain = [refs, msgId].filter(Boolean).join(" ");
        if (referencesChain) lines.push(`References: ${referencesChain}`);
      }
    }

    lines.push("");
    lines.push(opts.body ?? "");

    const raw = Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");
    return { raw, threadId };
  }

  /**
   * Parse an RFC 5322 address-list header value into bare email addresses.
   * Strips display names and the surrounding angle brackets. Tolerates malformed
   * input (returns whatever looks like an email).
   */
  private parseAddressList(headerValue: string): string[] {
    if (!headerValue) return [];
    const result: string[] = [];
    // Split on commas that aren't inside quoted display names. Simple split is
    // close enough for normal Gmail headers; edge cases (commas inside quoted
    // display names) are rare in practice.
    for (const part of headerValue.split(",")) {
      const m = part.match(/<([^>]+)>/);
      if (m) {
        result.push(m[1].trim());
      } else {
        const bare = part.trim();
        if (/\S+@\S+/.test(bare)) result.push(bare);
      }
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // batch_process — fetch structured data for Claude to decide on
  // -----------------------------------------------------------------------

  async batchProcess(
    query: string,
    maxResults: number = 20
  ): Promise<EmailSummary[]> {
    return this.listEmails(query, maxResults);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private extractBody(payload: gmail_v1.Schema$MessagePart): string {
    // Prefer text/plain, fall back to text/html
    if (payload.mimeType === "text/plain" && payload.body?.data) {
      return Buffer.from(payload.body.data, "base64url").toString("utf-8");
    }

    if (payload.mimeType === "text/html" && payload.body?.data) {
      return Buffer.from(payload.body.data, "base64url").toString("utf-8");
    }

    // Multipart: recurse
    if (payload.parts) {
      // Try text/plain first
      for (const part of payload.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          return Buffer.from(part.body.data, "base64url").toString("utf-8");
        }
      }
      // Fall back to text/html
      for (const part of payload.parts) {
        if (part.mimeType === "text/html" && part.body?.data) {
          return Buffer.from(part.body.data, "base64url").toString("utf-8");
        }
      }
      // Recurse into nested multipart
      for (const part of payload.parts) {
        const result = this.extractBody(part);
        if (result) return result;
      }
    }

    return "";
  }

  private parseUnsubscribeLinks(
    headers: Record<string, string>,
    body: string
  ): string[] {
    const links: string[] = [];

    // From List-Unsubscribe header
    const listUnsub = headers["List-Unsubscribe"] ?? "";
    links.push(...this.extractHttpLinks(listUnsub));

    const mailtoMatch = listUnsub.match(/mailto:([^>,\s]+)/i);
    if (mailtoMatch) links.push(`mailto:${mailtoMatch[1]}`);

    // From body
    links.push(...this.extractUnsubscribeLinksFromBody(body));

    return [...new Set(links)];
  }

  private extractHttpLinks(text: string): string[] {
    const matches = text.match(/https?:\/\/[^>,\s<]+/gi);
    return matches ?? [];
  }

  private extractUnsubscribeLinksFromBody(body: string): string[] {
    const links: string[] = [];
    // Match href links near "unsubscribe" text
    const hrefPattern =
      /href\s*=\s*["']?(https?:\/\/[^"'\s>]+(?:unsubscribe|opt.?out|remove|manage.?preferences)[^"'\s>]*)["']?/gi;
    let match;
    while ((match = hrefPattern.exec(body)) !== null) {
      links.push(match[1]);
    }
    // Also match plain URLs with unsubscribe keywords
    const urlPattern =
      /(https?:\/\/\S+(?:unsubscribe|opt.?out|remove|manage.?preferences)\S*)/gi;
    while ((match = urlPattern.exec(body)) !== null) {
      if (!links.includes(match[1])) {
        links.push(match[1]);
      }
    }
    return [...new Set(links)];
  }
}
