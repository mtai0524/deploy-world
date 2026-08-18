/**
 * Lớp gọi Render REST API (https://api-docs.render.com).
 *
 * Lưu ý quan trọng về giới hạn của Render: API tạo service BẮT BUỘC có trường
 * `repo` trỏ tới một git repository. Render không có endpoint upload file, nên
 * mọi luồng deploy ở đây đều phải đi qua GitHub trước.
 */

const API = "https://api.render.com/v1";

export class RenderError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = "RenderError";
    this.status = status;
    this.detail = detail;
  }
}

async function rd(key, path, { method = "GET", body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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
    throw new RenderError(`Render ${res.status}: ${reason}`, res.status, payload);
  }
  return payload;
}

/** Workspace gắn với API key. ownerId là bắt buộc khi tạo service. */
export async function getOwner(key) {
  const owners = await rd(key, "/owners?limit=20");
  const first = Array.isArray(owners) ? owners[0]?.owner : null;
  if (!first) {
    throw new RenderError("Không tìm thấy workspace nào cho API key này.", 400);
  }
  return { id: first.id, name: first.name, email: first.email };
}

/** Toàn bộ static site trong workspace, mới cập nhật nhất lên đầu. */
export async function listStaticSites(key) {
  const results = await rd(key, "/services?type=static_site&limit=100");

  return (Array.isArray(results) ? results : [])
    .map((item) => item.service)
    .filter(Boolean)
    .map((service) => ({
      id: service.id,
      name: service.name,
      url: service.serviceDetails?.url || null,
      dashboardUrl: service.dashboardUrl || null,
      updatedAt: service.updatedAt || service.createdAt || null,
      state: service.suspended === "suspended" ? "tạm dừng" : "đang chạy",
    }))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

/** Tìm service theo tên để lần deploy sau dùng lại thay vì tạo trùng. */
export async function findServiceByName(key, name) {
  const results = await rd(key, `/services?name=${encodeURIComponent(name)}&limit=20`);
  const match = (Array.isArray(results) ? results : [])
    .map((item) => item.service)
    .find((service) => service?.name === name);
  return match || null;
}

/**
 * Tạo static site trỏ vào repo GitHub.
 * publishPath "." vì file người dùng được commit thẳng ở gốc repo.
 */
export async function createStaticSite(key, { ownerId, name, repoUrl, branch = "main" }) {
  const service = await rd(key, "/services", {
    method: "POST",
    body: {
      type: "static_site",
      name,
      ownerId,
      repo: repoUrl,
      branch,
      autoDeploy: "yes",
      serviceDetails: {
        // Không có bước build, nhưng Render vẫn cần một lệnh hợp lệ.
        buildCommand: "echo 'no build step'",
        publishPath: ".",
      },
    },
  });

  // Response bọc service trong { service, deployId } tuỳ endpoint
  const created = service.service || service;
  return {
    id: created.id,
    name: created.name,
    url: created.serviceDetails?.url || null,
    dashboardUrl: created.dashboardUrl || null,
    deployId: service.deployId || null,
  };
}

/** Bắt Render kéo commit mới nhất và build lại. */
export async function triggerDeploy(key, serviceId) {
  const deploy = await rd(key, `/services/${serviceId}/deploys`, {
    method: "POST",
    body: { clearCache: "do_not_clear" },
  });
  return { id: deploy.id, status: deploy.status };
}

export async function getDeploy(key, serviceId, deployId) {
  const deploy = await rd(key, `/services/${serviceId}/deploys/${deployId}`);
  return {
    id: deploy.id,
    status: deploy.status,
    finishedAt: deploy.finishedAt || null,
    commitMessage: deploy.commit?.message || null,
  };
}

/** Xoá service. Không hoàn tác được — tầng gọi phải xác nhận trước. */
export async function deleteService(key, serviceId) {
  await rd(key, `/services/${serviceId}`, { method: "DELETE" });
  return { deleted: true };
}

export async function getService(key, serviceId) {
  const service = await rd(key, `/services/${serviceId}`);
  return {
    id: service.id,
    name: service.name,
    url: service.serviceDetails?.url || null,
    dashboardUrl: service.dashboardUrl || null,
  };
}

// Trạng thái deploy do Render trả về, nhóm lại cho giao diện dễ xử lý.
export const TERMINAL_OK = new Set(["live"]);
export const TERMINAL_FAIL = new Set([
  "build_failed",
  "update_failed",
  "canceled",
  "pre_deploy_failed",
  "deactivated",
]);

export function isFinished(status) {
  return TERMINAL_OK.has(status) || TERMINAL_FAIL.has(status);
}
