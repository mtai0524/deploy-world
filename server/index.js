import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeFiles, slugify, LIMITS, ValidationError } from "./lib/validate.js";
import * as github from "./lib/github.js";
import * as render from "./lib/render.js";
import * as netlify from "./lib/netlify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// base64 nở ~33% so với file gốc, cộng thêm phần bọc JSON
app.use(express.json({ limit: "40mb" }));
app.use(express.static(path.join(__dirname, "..", "web")));

function requireKey(value, envName, label) {
  const key = (value || process.env[envName] || "").trim();
  if (!key) {
    throw new ValidationError(
      `Thiếu ${label}. Nhập ở phần Cấu hình hoặc đặt ${envName} trên server.`
    );
  }
  return key;
}

/* ------------------------------------------------------------------ *
 * Netlify: nhận file trực tiếp, không cần git.
 * ------------------------------------------------------------------ */

async function deployToNetlify({ body, name, files }) {
  const token = requireKey(body.netlifyToken, "NETLIFY_TOKEN", "Netlify token");
  const steps = [];

  const viewer = await netlify.getViewer(token);
  steps.push({ label: `Xác thực Netlify: ${viewer.name || viewer.email}`, ok: true });

  const site = await netlify.ensureSite(token, name);
  steps.push({
    label: site.existed ? `Dùng lại site "${site.name}"` : `Tạo site "${site.name}"`,
    ok: true,
  });

  const deploy = await netlify.deployFiles(token, site.id, files);
  steps.push({
    label:
      `Upload ${deploy.uploaded} file` +
      (deploy.skipped ? ` (bỏ qua ${deploy.skipped} file Netlify đã có)` : ""),
    ok: true,
  });

  return {
    provider: "netlify",
    steps,
    siteId: site.id,
    deployId: deploy.id,
    siteUrl: site.url,
    dashboardUrl: site.adminUrl,
    repoUrl: null,
  };
}

/* ------------------------------------------------------------------ *
 * Render: API bắt buộc có git repo, nên phải commit lên GitHub trước.
 * ------------------------------------------------------------------ */

async function deployToRender({ body, name, files }) {
  const githubToken = requireKey(body.githubToken, "GITHUB_TOKEN", "GitHub token");
  const renderApiKey = requireKey(body.renderApiKey, "RENDER_API_KEY", "Render API key");
  const steps = [];

  const viewer = await github.getViewer(githubToken);
  steps.push({ label: `Xác thực GitHub: @${viewer.login}`, ok: true });

  const repo = await github.ensureRepo(githubToken, name, {
    description: "Site tĩnh deploy bằng Deploy World",
  });

  // Gom mọi rào cản rồi báo một lần, tránh bắt người dùng sửa từng vòng
  const blockers = [];

  if (repo.existed && repo.hasCommits && !body.overwriteExisting) {
    blockers.push(
      `Repo "${repo.fullName}" đã tồn tại và đang có nội dung. Deploy sẽ thay toàn bộ ` +
        `file trên nhánh ${repo.defaultBranch} bằng file bạn vừa chọn. Đổi tên site để ` +
        `dùng repo khác, hoặc bật "Ghi đè repo có sẵn" nếu đúng ý bạn.`
    );
  }

  // Chỉ chuyển repo sang public khi người dùng đã tick đồng ý, vì đây là hành
  // động công khai source ra Internet và không tự hoàn tác được.
  let madePublic = false;

  if (repo.isPrivate && body.makeRepoPublic) {
    const updated = await github.makeRepoPublic(githubToken, repo.fullName);
    if (updated.isPrivate) {
      blockers.push(
        `Không chuyển được "${repo.fullName}" sang public — nhiều khả năng token thiếu ` +
          `quyền quản trị repo, hoặc tổ chức chặn repo public.`
      );
    } else {
      repo.isPrivate = false;
      madePublic = true;
    }
  }

  if (repo.isPrivate) {
    blockers.push(
      `Repo "${repo.fullName}" đang private nên Render không fetch được (lỗi "invalid or ` +
        `unfetchable"). Cách xử lý: dùng Netlify thay vì Render (không cần git), tick ` +
        `"Chuyển repo sang public", đổi tên site, hoặc cài Render GitHub App tại ` +
        `github.com/apps/render/installations/new để Render đọc được repo private.`
    );
  }

  if (blockers.length) {
    const error = new ValidationError(blockers.join(" | "));
    error.detail = blockers;
    throw error;
  }

  steps.push({
    label: repo.existed ? `Dùng lại repo ${repo.fullName}` : `Tạo repo ${repo.fullName}`,
    ok: true,
  });

  if (madePublic) {
    steps.push({ label: `Đã chuyển ${repo.fullName} sang public`, ok: true });
  }

  const commit = await github.commitFiles(githubToken, repo.fullName, files, {
    branch: repo.defaultBranch,
    message: `Deploy ${files.length} file`,
  });
  steps.push({ label: `Commit ${commit.fileCount} file (${commit.sha.slice(0, 7)})`, ok: true });

  const owner = await render.getOwner(renderApiKey);
  steps.push({ label: `Workspace Render: ${owner.name}`, ok: true });

  let service = await render.findServiceByName(renderApiKey, name);
  let deployId = null;

  if (service) {
    // Service đã có từ lần trước: chỉ cần bảo Render kéo commit mới
    const deploy = await render.triggerDeploy(renderApiKey, service.id);
    deployId = deploy.id;
    service = await render.getService(renderApiKey, service.id);
    steps.push({ label: "Trigger deploy lại cho service có sẵn", ok: true });
  } else {
    service = await render.createStaticSite(renderApiKey, {
      ownerId: owner.id,
      name,
      repoUrl: repo.htmlUrl,
      branch: repo.defaultBranch,
    });
    deployId = service.deployId;
    steps.push({ label: `Tạo static site "${service.name}"`, ok: true });

    // Có trường hợp Render không trả deployId ngay khi tạo service
    if (!deployId) {
      const deploy = await render.triggerDeploy(renderApiKey, service.id);
      deployId = deploy.id;
    }
  }

  return {
    provider: "render",
    steps,
    siteId: service.id,
    deployId,
    siteUrl: service.url,
    dashboardUrl: service.dashboardUrl,
    repoUrl: repo.htmlUrl,
  };
}

const PROVIDERS = {
  netlify: deployToNetlify,
  render: deployToRender,
};

/* ------------------------------- Routes ------------------------------- */

/** Giao diện dùng cái này để biết cần hỏi khoá nào. */
app.get("/api/config", (_req, res) => {
  res.json({
    limits: LIMITS,
    providers: {
      netlify: { hasServerKey: Boolean(process.env.NETLIFY_TOKEN) },
      render: {
        hasServerKey: Boolean(process.env.RENDER_API_KEY && process.env.GITHUB_TOKEN),
      },
    },
  });
});

app.post("/api/deploy", async (req, res, next) => {
  try {
    const body = req.body || {};
    const provider = body.provider || "netlify";
    const runDeploy = PROVIDERS[provider];

    if (!runDeploy) {
      throw new ValidationError(
        `Nhà cung cấp "${provider}" không hỗ trợ. Chọn netlify hoặc render.`
      );
    }

    const { files, notes, totalBytes } = normalizeFiles(body.files);
    const name = slugify(body.siteName, "site");

    const result = await runDeploy({ body, name, files });

    res.json({ ok: true, ...result, notes, fileCount: files.length, totalBytes });
  } catch (error) {
    next(error);
  }
});

/** Danh sách site đã deploy, để giao diện hiển thị lại cho người dùng. */
app.get("/api/sites/:provider", async (req, res, next) => {
  try {
    const { provider } = req.params;
    const providedKey = req.get("x-provider-key") || "";

    if (provider === "netlify") {
      const token = requireKey(providedKey, "NETLIFY_TOKEN", "Netlify token");
      return res.json({ ok: true, provider, sites: await netlify.listSites(token) });
    }

    if (provider === "render") {
      const key = requireKey(providedKey, "RENDER_API_KEY", "Render API key");
      return res.json({ ok: true, provider, sites: await render.listStaticSites(key) });
    }

    throw new ValidationError(`Nhà cung cấp "${provider}" không hỗ trợ.`);
  } catch (error) {
    next(error);
  }
});

/** Giao diện gọi liên tục endpoint này để theo dõi tiến độ build. */
app.get("/api/deploy/:provider/:siteId/:deployId", async (req, res, next) => {
  try {
    const { provider, siteId, deployId } = req.params;
    const providedKey = req.get("x-provider-key") || "";

    if (provider === "netlify") {
      const token = requireKey(providedKey, "NETLIFY_TOKEN", "Netlify token");
      const deploy = await netlify.getDeploy(token, deployId);
      const site = await netlify.getSite(token, siteId);
      const finished = netlify.isFinished(deploy.state);
      const failed = netlify.TERMINAL_FAIL.has(deploy.state);

      // Chỉ kiểm tra khi đã xong, tránh gọi thừa ở mỗi vòng poll
      const access =
        finished && !failed
          ? await netlify.checkPublicAccess(site.url)
          : { checked: false, isPublic: null };

      return res.json({
        ok: true,
        status: deploy.state,
        finished,
        failed,
        siteUrl: site.url,
        dashboardUrl: site.adminUrl,
        isPublic: access.isPublic,
        accessChecked: access.checked,
      });
    }

    if (provider === "render") {
      const key = requireKey(providedKey, "RENDER_API_KEY", "Render API key");
      const deploy = await render.getDeploy(key, siteId, deployId);
      const service = await render.getService(key, siteId);

      return res.json({
        ok: true,
        status: deploy.status,
        finished: render.isFinished(deploy.status),
        failed: render.TERMINAL_FAIL.has(deploy.status),
        siteUrl: service.url,
        dashboardUrl: service.dashboardUrl,
      });
    }

    throw new ValidationError(`Nhà cung cấp "${provider}" không hỗ trợ.`);
  } catch (error) {
    next(error);
  }
});

// Xử lý lỗi tập trung. Tuyệt đối không log token ra console.
app.use((error, _req, res, _next) => {
  const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
  if (status >= 500) console.error(`[${error.name || "Error"}]`, error.message);

  res.status(status).json({
    ok: false,
    error: error.message || "Lỗi không xác định",
    detail: error.detail?.errors || error.detail || null,
  });
});

app.listen(PORT, () => {
  console.log(`Deploy World đang chạy tại http://localhost:${PORT}`);
  console.log(
    `Khoá mặc định trên server — Netlify: ${process.env.NETLIFY_TOKEN ? "có" : "không"}, ` +
      `Render: ${process.env.RENDER_API_KEY && process.env.GITHUB_TOKEN ? "có" : "không"}`
  );
});
