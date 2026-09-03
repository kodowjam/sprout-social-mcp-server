/**
 * Sprout Social API client.
 *
 * Async HTTP client with Bearer token auth, exponential backoff on 429/5xx,
 * and proactive rate limiting (60 req/min).
 */

import {
  MAX_FILE_SIZE,
  extractGdriveFileId,
  detectMediaType,
} from "./media-utils.js";

const MAX_RETRIES = 3;
const RATE_LIMIT_PER_MINUTE = 60;

interface RequestOptions {
  method: string;
  path: string;
  json?: any;
  params?: Record<string, string>;
}

interface ApiResponse {
  [key: string]: any;
}

export class SproutClient {
  private token: string;
  private customerId: string;
  private baseUrl: string;
  private requestTimestamps: number[] = [];

  constructor(
    token: string,
    customerId: string,
    baseUrl = "https://api.sproutsocial.com"
  ) {
    this.token = token;
    this.customerId = customerId;
    this.baseUrl = baseUrl;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();

    // Remove timestamps older than 60 seconds
    this.requestTimestamps = this.requestTimestamps.filter(
      (timestamp) => timestamp > now - 60000
    );

    if (this.requestTimestamps.length >= RATE_LIMIT_PER_MINUTE - 1) {
      const oldest = this.requestTimestamps[0];
      const wait = 60000 - (now - oldest) + 100;
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }

    this.requestTimestamps.push(Date.now());
  }

  private async request(options: RequestOptions): Promise<ApiResponse> {
    const { method, path, json, params } = options;
    const url = new URL(path, this.baseUrl);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    let lastStatus = 0;
    let lastBody = "";

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await this.throttle();

      const response = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: json ? JSON.stringify(json) : undefined,
      });

      if (response.status === 200 || response.status === 201) {
        return await response.json();
      }

      if (response.status === 204) {
        return { success: true };
      }

      lastStatus = response.status;
      lastBody = await response.text();

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const wait = Math.max(
          2 ** attempt * 1000,
          retryAfter ? parseInt(retryAfter) * 1000 : 0
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }

      if (response.status >= 500) {
        const wait = 2 ** attempt * 1000;
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }

      // 4xx (not 429) — don't retry
      return {
        error: lastBody,
        status_code: response.status,
      };
    }

    return {
      error: `Sprout API returned ${lastStatus} after ${MAX_RETRIES} retries`,
      status_code: lastStatus,
      sprout_error: lastBody,
      attempts: MAX_RETRIES,
    };
  }

  private async downloadGdriveFile(
    fileId: string
  ): Promise<{ data: Buffer; contentType: string; filename: string | null }> {
    const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

    let response = await fetch(downloadUrl, { redirect: "follow" });

    if (response.status === 404) {
      throw new Error(
        "Google Drive file not found. Check the file ID and ensure the file exists."
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Google Drive file not accessible. Ensure sharing is set to 'Anyone with the link'."
      );
    }

    let contentType = response.headers.get("content-type") || "";

    // Handle large-file confirmation page (virus scan warning)
    if (contentType.includes("text/html")) {
      const html = await response.text();
      let confirmToken: string | null = null;

      const match = html.match(/confirm=([a-zA-Z0-9_-]+)/);
      if (match) {
        confirmToken = match[1];
      }

      if (!confirmToken) {
        throw new Error(
          "Google Drive file not accessible. Ensure sharing is set to 'Anyone with the link' and the file exists."
        );
      }

      const confirmUrl = `https://drive.google.com/uc?export=download&confirm=${confirmToken}&id=${fileId}`;
      response = await fetch(confirmUrl, { redirect: "follow" });
    }

    // Check file size from Content-Length header
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
      throw new Error(
        `File exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB size limit (${Math.floor(parseInt(contentLength) / (1024 * 1024))}MB).`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const fileData = Buffer.from(arrayBuffer);

    if (fileData.length > MAX_FILE_SIZE) {
      throw new Error(
        `File exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB size limit (${Math.floor(fileData.length / (1024 * 1024))}MB).`
      );
    }

    contentType = response.headers.get("content-type") || "application/octet-stream";
    contentType = contentType.split(";")[0].trim();

    // Extract filename from Content-Disposition header
    let filename: string | null = null;
    const disposition = response.headers.get("content-disposition") || "";
    const fnMatch = disposition.match(/filename="?([^";]+)"?/);
    if (fnMatch) {
      filename = fnMatch[1].trim();
    }

    return { data: fileData, contentType, filename };
  }

  private async requestMultipart(
    path: string,
    fileData: Buffer,
    contentType: string,
    filename: string
  ): Promise<ApiResponse> {
    const url = new URL(path, this.baseUrl);

    let lastStatus = 0;
    let lastBody = "";

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await this.throttle();

      const formData = new FormData();
      formData.append(
        "media",
        new Blob([new Uint8Array(fileData)], { type: contentType }),
        filename
      );

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
        body: formData,
      });

      if (response.status === 200 || response.status === 201) {
        return await response.json();
      }

      if (response.status === 204) {
        return { success: true };
      }

      lastStatus = response.status;
      lastBody = await response.text();

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const wait = Math.max(
          2 ** attempt * 1000,
          retryAfter ? parseInt(retryAfter) * 1000 : 0
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }

      if (response.status >= 500) {
        const wait = 2 ** attempt * 1000;
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }

      return {
        error: lastBody,
        status_code: response.status,
      };
    }

    return {
      error: `Sprout API returned ${lastStatus} after ${MAX_RETRIES} retries`,
      status_code: lastStatus,
      sprout_error: lastBody,
      attempts: MAX_RETRIES,
    };
  }

  // --- Tier 1: Core Workflow ---

  async getCustomerId(): Promise<ApiResponse> {
    return await this.request({
      method: "GET",
      path: "/v1/metadata/client",
    });
  }

  async listProfiles(): Promise<ApiResponse> {
    return await this.request({
      method: "GET",
      path: `/v1/${this.customerId}/metadata/customer`,
    });
  }

  async createPost(
    profileIds: string[],
    text: string,
    groupId?: number,
    scheduledAt?: string,
    mediaIds?: string[],
    mediaTypes?: string[],
    tagIds?: number[]
  ): Promise<ApiResponse> {
    const body: any = {
      is_draft: true,
      customer_profile_ids: profileIds,
      text: text,
    };

    if (groupId !== undefined && groupId !== null) {
      body.group_id = Number(groupId);
    }
    if (scheduledAt) {
      body.delivery = {
        scheduled_times: [scheduledAt],
        type: "SCHEDULED",
      };
    }
    if (mediaIds) {
      const types = mediaTypes || mediaIds.map(() => "PHOTO");
      while (types.length < mediaIds.length) types.push("PHOTO");
      body.media = mediaIds.map((mid, i) => ({
        media_id: mid,
        media_type: types[i],
      }));
    }
    if (tagIds) {
      body.tag_ids = tagIds;
    }

    return await this.request({
      method: "POST",
      path: `/v1/${this.customerId}/publishing/posts`,
      json: body,
    });
  }

  async getPost(postId: string): Promise<ApiResponse> {
    return await this.request({
      method: "GET",
      path: `/v1/${this.customerId}/publishing/posts/${postId}`,
    });
  }

  // --- Tier 2: Media, Metadata & Post Management ---

  async uploadMedia(url: string): Promise<ApiResponse> {
    const fileId = extractGdriveFileId(url);
    if (fileId) {
      let fileData: Buffer;
      let contentType: string;
      let filename: string | null;

      try {
        ({ data: fileData, contentType, filename } =
          await this.downloadGdriveFile(fileId));
      } catch (err: any) {
        return { error: err.message };
      }

      const mediaType = detectMediaType(contentType, filename);
      if (!filename) {
        const extMap: Record<string, string> = {
          "image/jpeg": ".jpg",
          "image/png": ".png",
          "image/gif": ".gif",
          "image/webp": ".webp",
          "image/bmp": ".bmp",
          "video/mp4": ".mp4",
          "video/quicktime": ".mov",
          "video/x-msvideo": ".avi",
          "video/webm": ".webm",
          "video/mpeg": ".mpeg",
        };
        const ext = extMap[contentType] || ".bin";
        filename = `media${ext}`;
      }

      const result = await this.requestMultipart(
        `/v1/${this.customerId}/media/`,
        fileData,
        contentType,
        filename
      );
      if (!("error" in result)) {
        result._detected_media_type = mediaType;
      }
      return result;
    }

    return await this.request({
      method: "POST",
      path: `/v1/${this.customerId}/media/`,
      json: { url },
    });
  }

  async listTags(): Promise<ApiResponse> {
    return await this.request({
      method: "GET",
      path: `/v1/${this.customerId}/metadata/customer/tags`,
    });
  }

  async listUsers(): Promise<ApiResponse> {
    return await this.request({
      method: "GET",
      path: `/v1/${this.customerId}/metadata/customer/users`,
    });
  }

  // --- Tier 3: Analytics ---

  async getProfileAnalytics(
    profileIds: string[],
    startDate: string,
    endDate: string,
    metrics: string[]
  ): Promise<ApiResponse> {
    const body = {
      filters: [
        `customer_profile_id.eq(${profileIds.join(",")})`,
        `reporting_period.in(${startDate}...${endDate})`,
      ],
      metrics,
    };

    return await this.request({
      method: "POST",
      path: `/v1/${this.customerId}/analytics/profiles`,
      json: body,
    });
  }

  async getPostAnalytics(
    profileIds: string[],
    startDate: string,
    endDate: string,
    metrics?: string[]
  ): Promise<ApiResponse> {
    const defaultMetrics = [
      "lifetime.impressions",
      "lifetime.engagements",
      "lifetime.post_link_clicks",
      "lifetime.post_shares_count",
      "lifetime.likes",
      "lifetime.comments_count",
    ];

    const body = {
      filters: [
        `customer_profile_id.eq(${profileIds.join(",")})`,
        `created_time.in(${startDate}T00:00:00..${endDate}T23:59:59)`,
      ],
      fields: [
        "created_time",
        "perma_link",
        "text",
        "internal.sent_by.email",
      ],
      metrics: metrics || defaultMetrics,
      page: 1,
    };

    // Auto-paginate: the posts endpoint returns max 50 results per page.
    const allData: any[] = [];
    let page = 1;

    while (true) {
      body.page = page;
      const result = await this.request({
        method: "POST",
        path: `/v1/${this.customerId}/analytics/posts`,
        json: body,
      });

      if ("error" in result) {
        return result;
      }

      allData.push(...(result.data || []));

      const paging = result.paging || {};
      if (page >= (paging.total_pages || 1)) {
        break;
      }
      page++;
    }

    return {
      data: allData,
      paging: { total_pages: page, total_results: allData.length },
    };
  }
}
