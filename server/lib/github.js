/**
 * Đẩy một tập file lên GitHub bằng Git Data API.
 *
 * Không dùng endpoint /contents vì nó tạo một commit cho mỗi file — chậm và
 * bẩn lịch sử. Git Data API gói tất cả vào đúng một commit:
 *   blob (từng file) -> tree (cây thư mục) -> commit -> cập nhật ref
 */

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.detail = detail;
  }
}

async function gh(token, path, { method = "GET", body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "deploy-world",
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
    const reason = payload?.message || res.statusText;
    throw new GitHubError(`GitHub ${res.status}: ${reason}`, res.status, payload);
  }
  return payload;
}

/** Lấy thông tin tài khoản gắn với token, cũng là cách kiểm tra token hợp lệ. */
export async function getViewer(token) {
  const user = await gh(token, "/user");
  return { login: user.login, name: user.name };
}

/**
 * Tạo repo mới, hoặc mô tả lại repo đã tồn tại cùng tên.
 *
 * Mặc định để public vì Render chỉ fetch được repo private khi tài khoản Render
 * đã kết nối GitHub qua OAuth — việc mà công cụ này không làm thay được.
 *
 * Hàm này KHÔNG tự ghi đè repo có sẵn. Nó trả về đủ thông tin để tầng gọi quyết
 * định, vì ghi đè nhầm một repo không liên quan là mất mát khó lường trước.
 */
export async function ensureRepo(token, name, { description, isPrivate = false } = {}) {
  try {
    const repo = await gh(token, "/user/repos", {
      method: "POST",
      body: {
        name,
        description: description || "Deploy bằng Deploy World",
        private: isPrivate,
        auto_init: false,
        has_issues: false,
        has_projects: false,
        has_wiki: false,
      },
    });
    return {
      fullName: repo.full_name,
      htmlUrl: repo.html_url,
      isPrivate: repo.private,
      defaultBranch: repo.default_branch || "main",
      existed: false,
      hasCommits: false,
    };
  } catch (error) {
    // 422 = đã có repo trùng tên. Không tự động dùng lại — chỉ báo cáo hiện trạng.
    if (error.status === 422) {
      const { login } = await getViewer(token);
      const existing = await gh(token, `/repos/${login}/${name}`);
      const branch = existing.default_branch || "main";
      const head = await getBranchHead(token, existing.full_name, branch);

      return {
        fullName: existing.full_name,
        htmlUrl: existing.html_url,
        isPrivate: existing.private,
        defaultBranch: branch,
        existed: true,
        hasCommits: head !== null,
      };
    }
    throw error;
  }
}

/**
 * Chuyển repo sang public để Render fetch được.
 *
 * Đây là hành động công khai source ra Internet và không tự hoàn tác, nên tầng
 * gọi chỉ được dùng khi người dùng đã đồng ý tường minh.
 * Token cần quyền quản trị repo (classic: scope `repo`; fine-grained:
 * Administration Read and write).
 */
export async function makeRepoPublic(token, fullName) {
  const repo = await gh(token, `/repos/${fullName}`, {
    method: "PATCH",
    body: { private: false },
  });
  return { isPrivate: repo.private };
}

/** SHA của commit đang được branch trỏ tới, null nếu branch chưa tồn tại. */
async function getBranchHead(token, fullName, branch) {
  try {
    const ref = await gh(token, `/repos/${fullName}/git/ref/heads/${branch}`);
    return ref.object.sha;
  } catch (error) {
    if (error.status === 404 || error.status === 409) return null; // repo rỗng
    throw error;
  }
}

/**
 * Commit toàn bộ file vào branch, gộp thành một commit duy nhất.
 * @param {Array<{path: string, content: string}>} files - content dạng base64
 */
export async function commitFiles(token, fullName, files, { branch = "main", message } = {}) {
  // 1. Upload nội dung từng file, nhận về sha của blob
  const blobs = [];
  for (const file of files) {
    const blob = await gh(token, `/repos/${fullName}/git/blobs`, {
      method: "POST",
      body: { content: file.content, encoding: "base64" },
    });
    blobs.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const parentSha = await getBranchHead(token, fullName, branch);

  // 2. Dựng cây thư mục.
  // Không truyền base_tree: cây mới thay thế hoàn toàn cây cũ, nên file người
  // dùng đã xoá ở lần deploy trước cũng biến mất khỏi site.
  const tree = await gh(token, `/repos/${fullName}/git/trees`, {
    method: "POST",
    body: { tree: blobs },
  });

  // 3. Tạo commit
  const commit = await gh(token, `/repos/${fullName}/git/commits`, {
    method: "POST",
    body: {
      message: message || "Deploy từ Deploy World",
      tree: tree.sha,
      parents: parentSha ? [parentSha] : [],
    },
  });

  // 4. Trỏ branch vào commit vừa tạo
  if (parentSha) {
    await gh(token, `/repos/${fullName}/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: { sha: commit.sha, force: true },
    });
  } else {
    await gh(token, `/repos/${fullName}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
    });
  }

  return { sha: commit.sha, fileCount: files.length };
}
