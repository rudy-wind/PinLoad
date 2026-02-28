/**
 * Cloudflare Workers - Pinterest Downloader (Video + Photo + Pin Info)
 *
 * Endpoint:
 *   GET /?url=https://www.pinterest.com/pin/XXXXXXXXX
 *   GET /?url=https://pin.it/XXXXXXX   (short URL supported)
 *
 * Response JSON:
 *   {
 *     success: true,
 *     type: "video" | "image" | "unknown",
 *     pin_url: string,
 *     uploader: { name, username, profile_url, avatar_url },
 *     title: string,
 *     description: string,
 *     thumbnail: string,
 *     images: [ { quality, url, width, height } ],
 *     videos: [ { quality, url, width, height } ],  // only if type === "video"
 *     video_url: string | null,
 *     duration: number | null,
 *   }
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return jsonResponse({ success: false, error: "Method tidak diizinkan. Gunakan GET." }, 405);
    }

    const reqUrl = new URL(request.url);
    const pinUrl = reqUrl.searchParams.get("url");

    if (!pinUrl) {
      return jsonResponse(
        {
          success: false,
          error: "Parameter 'url' wajib diisi.",
          example: "/?url=https://www.pinterest.com/pin/123456789",
        },
        400
      );
    }

    if (!isValidPinterestUrl(pinUrl)) {
      return jsonResponse(
        {
          success: false,
          error: "URL tidak valid. Harus berupa URL Pinterest (pinterest.com/pin/... atau pin.it/...).",
        },
        400
      );
    }

    try {
      const resolvedUrl = await resolveUrl(pinUrl);
      const html = await fetchPinterestPage(resolvedUrl);
      const pinData = extractPinData(html, resolvedUrl);

      if (!pinData) {
        return jsonResponse(
          {
            success: false,
            error: "Gagal mengekstrak data pin. Pin mungkin bersifat privat atau URL tidak valid.",
            pin_url: resolvedUrl,
          },
          404
        );
      }

      return jsonResponse({ success: true, pin_url: resolvedUrl, ...pinData });
    } catch (err) {
      console.error("[Pinterest Worker Error]", err);
      return jsonResponse(
        {
          success: false,
          error: err.message || "Terjadi kesalahan internal saat memproses permintaan.",
        },
        500
      );
    }
  },
};

// ---------------------------------------------------------------------------
// URL Helpers
// ---------------------------------------------------------------------------

function isValidPinterestUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname.includes("pinterest.") ||
      u.hostname === "pin.it" ||
      u.hostname.includes("pinterest.co")
    );
  } catch {
    return false;
  }
}

async function resolveUrl(inputUrl) {
  if (inputUrl.includes("pin.it") || !inputUrl.includes("pinterest.com/pin/")) {
    const res = await fetch(inputUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    });
    return res.url;
  }
  return inputUrl;
}

// ---------------------------------------------------------------------------
// Fetch Pinterest Page
// ---------------------------------------------------------------------------

async function fetchPinterestPage(pinUrl) {
  const res = await fetch(pinUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
  });

  if (!res.ok) {
    throw new Error(`Gagal mengakses Pinterest: HTTP ${res.status} ${res.statusText}`);
  }

  return await res.text();
}

// ---------------------------------------------------------------------------
// Main Extractor
// ---------------------------------------------------------------------------

function extractPinData(html, pinUrl) {
  // Strategy 1: __PWS_DATA__
  const pwsMatch = html.match(/\("__PWS_DATA__"\s*,\s*({.+?})\)/s);
  if (pwsMatch) {
    try {
      const data = JSON.parse(pwsMatch[1]);
      const pin = findPinObject(data);
      if (pin) return buildResult(pin);
    } catch (_) {}
  }

  // Strategy 2: window.__INITIAL_STATE__
  const initialMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});\s*<\/script>/s);
  if (initialMatch) {
    try {
      const data = JSON.parse(initialMatch[1]);
      const pin = findPinObject(data);
      if (pin) return buildResult(pin);
    } catch (_) {}
  }

  // Strategy 3: JSON-LD
  const ldResult = extractFromLdJson(html);
  if (ldResult) return ldResult;

  // Strategy 4: Regex fallback (og tags + raw video/image URLs)
  return extractFromRegex(html);
}

// ---------------------------------------------------------------------------
// Strategy 3: JSON-LD
// ---------------------------------------------------------------------------

function extractFromLdJson(html) {
  const blocks = html.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/g);
  if (!blocks) return null;

  for (const block of blocks) {
    try {
      const content = block.replace(/<script[^>]*>|<\/script>/g, "").trim();
      const data = JSON.parse(content);
      const type = (data["@type"] || "").toLowerCase();

      if (type.includes("video") || data.video || type.includes("imageobject") || data.image) {
        const result = {
          type: type.includes("video") || data.video ? "video" : "image",
          title: data.name || "",
          description: data.description || "",
          thumbnail: data.thumbnailUrl || data.image || "",
          uploader: extractUploaderFromLd(data),
          images: [],
          videos: [],
          video_url: null,
          duration: null,
        };

        if (data.contentUrl) {
          result.video_url = data.contentUrl;
          result.videos.push({ quality: "default", url: data.contentUrl });
        } else if (data.video && data.video.contentUrl) {
          result.video_url = data.video.contentUrl;
          result.videos.push({ quality: "default", url: data.video.contentUrl });
        } else {
          result.type = "image";
        }

        if (data.image) {
          result.images.push({ quality: "default", url: data.image });
        }

        return result;
      }
    } catch (_) {}
  }
  return null;
}

function extractUploaderFromLd(data) {
  const author = data.author || data.creator || {};
  return {
    name: author.name || "",
    username: "",
    profile_url: author.url || "",
    avatar_url: author.image || "",
  };
}

// ---------------------------------------------------------------------------
// Strategy 4: Regex fallback
// ---------------------------------------------------------------------------

function extractFromRegex(html) {
  const title = extractMeta(html, "og:title") || extractMeta(html, "title") || "";
  const description = extractMeta(html, "og:description") || extractMeta(html, "description") || "";
  const thumbnail = extractMeta(html, "og:image") || "";

  // Videos
  const videoPatterns = [
    /["'](https:\/\/v\.pinimg\.com[^"']+\.m3u8[^"']*)['"]/g,
    /["'](https:\/\/v\.pinimg\.com[^"']+\.mp4[^"']*)['"]/g,
    /["'](https:\/\/[^"']+\/videos\/[^"']+\.mp4[^"']*)['"]/g,
  ];

  let videoUrls = [];
  for (const pat of videoPatterns) {
    const matches = [...html.matchAll(pat)];
    if (matches.length) {
      videoUrls = [...new Set(matches.map((m) => m[1]))];
      break;
    }
  }

  // Images
  const imgPatterns = [
    /["'](https:\/\/i\.pinimg\.com\/[^"']+\/[^"']+\.(?:jpg|jpeg|png|webp))['"]/g,
  ];
  let imageUrls = [];
  for (const pat of imgPatterns) {
    const matches = [...html.matchAll(pat)];
    imageUrls = [...new Set(matches.map((m) => m[1]))];
    break;
  }

  const hasVideo = videoUrls.length > 0;
  const hasImage = imageUrls.length > 0 || thumbnail;

  if (!hasVideo && !hasImage) return null;

  return {
    type: hasVideo ? "video" : "image",
    title: decodeHtmlEntities(title),
    description: decodeHtmlEntities(description),
    thumbnail,
    uploader: extractUploaderFromHtml(html),
    images: imageUrls.map((url, i) => ({ quality: `img_${i + 1}`, url })),
    videos: videoUrls.map((url, i) => ({ quality: `src_${i + 1}`, url })),
    video_url: videoUrls[0] || null,
    duration: null,
  };
}

function extractMeta(html, name) {
  const patterns = [
    new RegExp(`property="${name}"\\s+content="([^"]+)"`, "i"),
    new RegExp(`name="${name}"\\s+content="([^"]+)"`, "i"),
    new RegExp(`content="([^"]+)"\\s+property="${name}"`, "i"),
    new RegExp(`content="([^"]+)"\\s+name="${name}"`, "i"),
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) return m[1];
  }
  return null;
}

function extractUploaderFromHtml(html) {
  // Try to grab pinner/uploader from og or json fragments
  const uploaderName =
    html.match(/"full_name"\s*:\s*"([^"]+)"/)?.[1] ||
    html.match(/"pinner"\s*:\s*\{[^}]*"full_name"\s*:\s*"([^"]+)"/s)?.[1] ||
    "";

  const username =
    html.match(/"username"\s*:\s*"([^"]+)"/)?.[1] || "";

  const avatarUrl =
    html.match(/"image_medium_url"\s*:\s*"([^"]+)"/)?.[1] ||
    html.match(/"profile_cover"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/s)?.[1] ||
    "";

  return {
    name: uploaderName,
    username,
    profile_url: username ? `https://www.pinterest.com/${username}/` : "",
    avatar_url: avatarUrl,
  };
}

// ---------------------------------------------------------------------------
// Redux Object Finder & Builder
// ---------------------------------------------------------------------------

function findPinObject(obj, depth = 0) {
  if (depth > 12 || typeof obj !== "object" || obj === null) return null;

  if (
    (obj.type === "pin" && obj.id) ||
    obj.videos ||
    (obj.images && obj.description !== undefined)
  ) {
    return obj;
  }

  for (const key of Object.keys(obj)) {
    const found = findPinObject(obj[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function buildResult(pin) {
  const result = {
    type: "image",
    title: decodeHtmlEntities(pin.title || pin.grid_title || ""),
    description: decodeHtmlEntities(pin.description || ""),
    thumbnail: "",
    uploader: extractUploader(pin),
    images: [],
    videos: [],
    video_url: null,
    duration: null,
  };

  // Images
  if (pin.images) {
    const entries = Object.entries(pin.images);
    result.images = entries
      .filter(([, v]) => v && v.url)
      .map(([k, v]) => ({ quality: k, url: v.url, width: v.width || null, height: v.height || null }));
    result.thumbnail = result.images[result.images.length - 1]?.url || "";
  }

  // Videos
  if (pin.videos && pin.videos.video_list) {
    const vl = pin.videos.video_list;
    const qualities = Object.entries(vl)
      .filter(([, v]) => v && v.url)
      .map(([k, v]) => ({ quality: k, url: v.url, width: v.width || null, height: v.height || null }))
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    result.videos = qualities;
    result.video_url = qualities[0]?.url || null;
    result.type = result.video_url ? "video" : "image";

    const durMs =
      vl.V_1080P?.duration ||
      vl.V_720P?.duration ||
      vl.V_480P?.duration ||
      vl.V_HLSV4?.duration ||
      null;
    if (durMs) result.duration = Math.round(durMs / 1000);

    // Use HLS thumbnail if available
    if (!result.thumbnail && vl.V_HLSV4?.thumbnail) {
      result.thumbnail = vl.V_HLSV4.thumbnail;
    }
  }

  // story_pin_data fallback
  if (!result.video_url && pin.story_pin_data) {
    for (const page of pin.story_pin_data.pages || []) {
      for (const block of page.blocks || []) {
        if (block.video?.video_list) {
          const entries = Object.values(block.video.video_list).filter((v) => v?.url);
          if (entries.length) {
            result.video_url = entries[0].url;
            result.videos = entries.map((v, i) => ({ quality: `q${i + 1}`, url: v.url }));
            result.type = "video";
            break;
          }
        }
        if (block.image?.images) {
          const imgs = Object.entries(block.image.images)
            .filter(([, v]) => v?.url)
            .map(([k, v]) => ({ quality: k, url: v.url, width: v.width || null, height: v.height || null }));
          result.images.push(...imgs);
        }
      }
      if (result.video_url) break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Uploader Extractor
// ---------------------------------------------------------------------------

function extractUploader(pin) {
  const pinner = pin.pinner || pin.native_creator || {};

  const name = pinner.full_name || pinner.username || "";
  const username = pinner.username || "";
  const avatarUrl =
    pinner.image_medium_url ||
    pinner.image_large_url ||
    pinner.image_small_url ||
    (pinner.images && Object.values(pinner.images)[0]?.url) ||
    "";

  return {
    name,
    username,
    profile_url: username ? `https://www.pinterest.com/${username}/` : "",
    avatar_url: avatarUrl,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function decodeHtmlEntities(str = "") {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      ...CORS_HEADERS,
    },
  });
}
