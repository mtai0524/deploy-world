/**
 * Lớp gọi Netlify API (https://docs.netlify.com/api/get-started).
 *
 * Khác Render, Netlify nhận file trực tiếp nên không cần git repo trung gian.
 * Nhờ vậy không có chuyện repo public/private, và source người dùng không bị
 * đẩy ra chỗ nào khác ngoài chính Netlify.
 *
 * Luồng: khai báo sha1 của mọi file -> Netlify trả về danh sách file nó chưa
 * có -> upload đúng những file đó -> chờ deploy chuyển sang "ready".
 */

import crypto from "node:crypto";

const API = "https://api.netlify.com/api/v1";

export class NetlifyError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = "NetlifyError";
    this.status = status;
    this.detail = detail;
  }
}

async function nf(token, path, { method = "GET", body, raw, contentType } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (contentType) headers["Content-Type"] = contentType;
  else if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(API + path, {
    method,
    headers,
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!res.ok) {
    const reason = payload?.message || payload?.error || res.statusText;
    throw new NetlifyError(`Netlify ${res.status}: ${reason}`, res.status, payload);
  }
  return payload;
}

/** Kiểm tra token và lấy thông tin tài khoản. */
export async function getViewer(token) {
  const user = await nf(token, "/user");
  return { id: user.id, email: user.email, name: user.full_name || user.slug };
}

/** Toàn bộ site trong tài khoản, mới cập nhật nhất lên đầu. */
export async function listSites(token) {
  const sites = await nf(token, "/sites?per_page=100");

  return (Array.isArray(sites) ? sites : [])
    .map((site) => ({
      id: site.id,
      name: site.name,
      url: site.ssl_url || site.url,
      adminUrl: site.admin_url,
      // published_deploy chỉ có khi site đã deploy thành công ít nhất một lần
      updatedAt: site.published_deploy?.published_at || site.updated_at || null,
      state: site.published_deploy ? site.published_deploy.state : "chưa deploy",
    }))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

/** Tìm site theo tên trong tài khoản, null nếu chưa có. */
export async function findSiteByName(token, name) {
  const sites = await nf(token, `/sites?name=${encodeURIComponent(name)}&per_page=100`);
  const match = (Array.isArray(sites) ? sites : []).find((site) => site.name === name);
  if (!match) return null;

  return {
    id: match.id,
    name: match.name,
    url: match.ssl_url || match.url,
    adminUrl: match.admin_url,
    existed: true,
  };
}

/** Tạo site mới. Tên phải là duy nhất trên toàn Netlify vì nó thành subdomain. */
export async function createSite(token, name) {
  const site = await nf(token, "/sites", { method: "POST", body: { name } });
  return {
    id: site.id,
    name: site.name,
    url: site.ssl_url || site.url,
    adminUrl: site.admin_url,
    existed: false,
  };
}

export async function ensureSite(token, name) {
  const existing = await findSiteByName(token, name);
  if (existing) return existing;

  try {
    return await createSite(token, name);
  } catch (error) {
    // 422 = tên đã bị tài khoản khác chiếm (subdomain toàn cục)
    if (error.status === 422) {
      throw new NetlifyError(
        `Tên "${name}" đã có người dùng trên Netlify. Đổi tên site khác.`,
        400,
        error.detail
      );
    }
    throw error;
  }
}

/**
 * Đẩy toàn bộ file lên site.
 * @param {Array<{path: string, content: string}>} files - content dạng base64
 */
export async function deployFiles(token, siteId, files) {
  // Netlify khớp file theo sha1 của nội dung gốc, đường dẫn phải có "/" ở đầu
  const prepared = files.map((file) => {
    const buffer = Buffer.from(file.content, "base64");
    return {
      key: "/" + file.path,
      buffer,
      sha: crypto.createHash("sha1").update(buffer).digest("hex"),
    };
  });

  const digest = {};
  for (const item of prepared) digest[item.key] = item.sha;

  // draft: false = deploy này thành bản production đang chạy ngay khi xử lý xong.
  // Đây vốn là mặc định của Netlify, ghi ra tường minh để ý định nằm trong code
  // chứ không phụ thuộc vào mặc định của bên thứ ba.
  const deploy = await nf(token, `/sites/${siteId}/deploys`, {
    method: "POST",
    body: { files: digest, draft: false },
  });

  // Chỉ upload file Netlify báo là còn thiếu — lần deploy sau gần như tức thì
  const required = new Set(deploy.required || []);
  const toUpload = prepared.filter((item) => required.has(item.sha));

  for (const item of toUpload) {
    // Giữ nguyên dấu "/" phân cách thư mục, chỉ escape từng đoạn tên
    const encodedPath = item.key
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    await nf(token, `/deploys/${deploy.id}/files${encodedPath}`, {
      method: "PUT",
      raw: item.buffer,
      contentType: "application/octet-stream",
    });
  }

  return {
    id: deploy.id,
    state: deploy.state,
    uploaded: toUpload.length,
    skipped: prepared.length - toUpload.length,
  };
}

export async function getSite(token, siteId) {
  const site = await nf(token, `/sites/${siteId}`);
  return {
    id: site.id,
    name: site.name,
    url: site.ssl_url || site.url,
    adminUrl: site.admin_url,
  };
}

export async function getDeploy(token, deployId) {
  const deploy = await nf(token, `/deploys/${deployId}`);
  return {
    id: deploy.id,
    state: deploy.state,
    url: deploy.ssl_url || deploy.deploy_ssl_url || deploy.url || null,
    errorMessage: deploy.error_message || null,
  };
}

/**
 * Thử truy cập site như một người lạ, không kèm token.
 *
 * Từ 28/07/2026 Netlify đặt project mới ở chế độ private mặc định trên gói
 * Free/Personal/Pro: deploy vẫn thành công nhưng chỉ thành viên team xem được.
 * API công khai chưa có field nào đổi được visibility, nên thay vì đoán, công cụ
 * tự kiểm tra rồi báo cho người dùng biết cần bấm "Make public" trên dashboard.
 */
export async function checkPublicAccess(url) {
  if (!url) return { checked: false, isPublic: null, status: null };

  try {
    const res = await fetch(url, { method: "GET", redirect: "manual" });
    // Site private trả về 401, hoặc chuyển hướng sang trang đăng nhập Netlify.
    // Chỉ 2xx mới chắc chắn là người lạ xem được.
    return {
      checked: true,
      isPublic: res.status >= 200 && res.status < 300,
      status: res.status,
    };
  } catch {
    // Mạng lỗi thì không kết luận gì, tránh báo động giả
    return { checked: false, isPublic: null, status: null };
  }
}

// Trạng thái deploy của Netlify
export const TERMINAL_OK = new Set(["ready"]);
export const TERMINAL_FAIL = new Set(["error", "rejected"]);

export function isFinished(state) {
  return TERMINAL_OK.has(state) || TERMINAL_FAIL.has(state);
}
