/**
 * Kiểm tra và chuẩn hoá danh sách file người dùng gửi lên trước khi commit.
 * Mục tiêu: chặn path traversal, giới hạn dung lượng, và bỏ lớp thư mục thừa
 * sinh ra khi kéo thả nguyên một folder.
 */

export const LIMITS = {
  maxFiles: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
};

// Danh sách đen thay vì danh sách trắng: source code có đủ loại đuôi file, chặn
// theo whitelist thì luôn thiếu và âm thầm nuốt mất file của người dùng.
//
// Nhị phân thực thi: hosting tĩnh không chạy được, mà phát tán ra public thì
// nguy hiểm. Nhóm khoá/chứng chỉ riêng: xem BLOCKED_EXT phần dưới.
const BINARY_EXT = new Set([
  "exe", "dll", "msi", "bat", "cmd", "com", "scr", "vbs", "jar", "apk", "app",
  "so", "dylib", "o", "obj", "pdb", "class", "pyc", "pyo", "node", "bin",
]);

// Khoá riêng và kho chứng chỉ — kéo cả thư mục dự án rất dễ lôi nhầm lên.
// Tách khỏi BINARY_EXT để báo đúng lý do: đây là vấn đề lộ bí mật, không phải
// chuyện hosting tĩnh chạy được hay không.
const SECRET_EXT = new Set(["pem", "key", "p12", "pfx", "keystore", "jks", "ppk"]);

// Rác build/công cụ, không phải nội dung site
const JUNK = /(^|\/)(\.git|\.svn|\.hg|node_modules|__pycache__|\.venv|venv|\.next|\.nuxt|\.cache|\.idea|\.vscode|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i;

// File chứa bí mật. .env.example và họ hàng thì vô hại nên cho qua.
const SECRET_FILE =
  /(^|\/)(\.env(?!\.(example|sample|template|dist)$)(\..*)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|\.npmrc|\.netrc|\.pypirc|credentials|secrets?\.(json|ya?ml|toml))$/i;

// Dấu hiệu đây là source chưa build, không phải site chạy được
const NEEDS_BUILD_FILE = /(^|\/)(package\.json|vite\.config\.[jt]s|next\.config\.[jt]s|angular\.json|nuxt\.config\.[jt]s|svelte\.config\.js)$/i;
const SOURCE_ONLY_EXT = /\.(jsx|tsx|vue|svelte|scss|sass|less|styl|ts)$/i;

const IS_HTML = /\.html?$/i;

// Khi có nhiều trang mà không trang nào tên index, đây là những tên hay được
// dùng làm trang chủ. Xét theo thứ tự này.
const HOME_NAMES = ["home", "main", "default", "trang-chu", "trangchu", "start"];

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

function extensionOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Đường dẫn phải là relative, không chứa .. và không có ký tự điều khiển. */
function sanitizePath(raw) {
  const path = String(raw || "").replace(/\\/g, "/").replace(/^\.\//, "");

  if (!path) throw new ValidationError("Có file không có đường dẫn.");
  if (path.startsWith("/")) {
    throw new ValidationError(`Đường dẫn tuyệt đối không được phép: ${path}`);
  }
  if (/^[a-zA-Z]:/.test(path)) {
    throw new ValidationError(`Đường dẫn tuyệt đối không được phép: ${path}`);
  }
  if (path.split("/").includes("..")) {
    throw new ValidationError(`Đường dẫn không hợp lệ: ${path}`);
  }
  if (CONTROL_CHARS.test(path)) {
    throw new ValidationError(`Đường dẫn chứa ký tự điều khiển: ${path}`);
  }
  if (path.length > 255) {
    throw new ValidationError(`Đường dẫn quá dài: ${path.slice(0, 60)}...`);
  }

  return path;
}

/**
 * Khi kéo thả một folder, mọi đường dẫn đều bắt đầu bằng tên folder đó.
 * Bỏ tiền tố chung để index.html nằm đúng ở gốc site.
 */
function stripCommonRoot(paths) {
  if (paths.length === 0) return "";

  const first = paths[0].split("/");
  if (first.length < 2) return "";

  const candidate = first[0] + "/";
  return paths.every((p) => p.startsWith(candidate)) ? candidate : "";
}

/**
 * @param {Array<{path: string, content: string}>} rawFiles - content dạng base64
 * @returns {{files: Array<{path, content, bytes}>, notes: string[], totalBytes: number}}
 */
export function normalizeFiles(rawFiles) {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new ValidationError("Chưa có file nào được gửi lên.");
  }
  if (rawFiles.length > LIMITS.maxFiles) {
    throw new ValidationError(
      `Tối đa ${LIMITS.maxFiles} file mỗi lần deploy, bạn gửi ${rawFiles.length} file.`
    );
  }

  const notes = [];
  const skippedJunk = [];
  const skippedSecret = [];
  const skippedBinary = [];
  const staged = [];
  let totalBytes = 0;

  for (const raw of rawFiles) {
    const path = sanitizePath(raw?.path);

    if (JUNK.test(path)) {
      skippedJunk.push(path);
      continue;
    }
    // Tách riêng khỏi nhóm rác: đây là thứ người dùng cần biết đã bị loại,
    // vì đẩy nhầm lên một site công khai là lộ bí mật thật.
    if (SECRET_FILE.test(path) || SECRET_EXT.has(extensionOf(path))) {
      skippedSecret.push(path);
      continue;
    }
    if (BINARY_EXT.has(extensionOf(path))) {
      skippedBinary.push(path);
      continue;
    }

    const content = String(raw?.content ?? "");
    const bytes = Math.floor((content.length * 3) / 4); // ước lượng từ base64

    if (bytes > LIMITS.maxFileBytes) {
      throw new ValidationError(
        `File ${path} nặng ${(bytes / 1048576).toFixed(1)}MB, vượt giới hạn ${LIMITS.maxFileBytes / 1048576}MB.`
      );
    }

    totalBytes += bytes;
    if (totalBytes > LIMITS.maxTotalBytes) {
      throw new ValidationError(
        `Tổng dung lượng vượt ${LIMITS.maxTotalBytes / 1048576}MB.`
      );
    }

    staged.push({ path, content, bytes });
  }

  if (staged.length === 0) {
    throw new ValidationError(
      "Không còn file nào sau khi lọc. Toàn bộ đều là rác build, file bí mật hoặc nhị phân."
    );
  }

  const prefix = stripCommonRoot(staged.map((f) => f.path));
  const files = prefix
    ? staged.map((f) => ({ ...f, path: f.path.slice(prefix.length) }))
    : staged;

  if (prefix) notes.push(`Đã bỏ thư mục bọc ngoài "${prefix.slice(0, -1)}".`);

  const summarize = (list) =>
    list.slice(0, 3).join(", ") + (list.length > 3 ? `... (+${list.length - 3})` : "");

  if (skippedJunk.length) {
    notes.push(`Bỏ qua ${skippedJunk.length} file rác build: ${summarize(skippedJunk)}`);
  }
  if (skippedBinary.length) {
    notes.push(
      `Bỏ qua ${skippedBinary.length} file nhị phân (hosting tĩnh không chạy được): ${summarize(skippedBinary)}`
    );
  }
  if (skippedSecret.length) {
    notes.push(
      `Đã chặn ${skippedSecret.length} file chứa bí mật, KHÔNG đưa lên: ${summarize(skippedSecret)}`
    );
  }

  const buildNote = detectUnbuiltProject(files);
  if (buildNote) notes.push(buildNote);

  const entryNote = ensureEntryPoint(files);
  if (entryNote) notes.push(entryNote);

  return { files, notes, totalBytes };
}

/**
 * Nhận ra source của framework chưa qua bước build.
 *
 * Hosting tĩnh phục vụ file y nguyên, không biên dịch gì. Đẩy thẳng src/App.jsx
 * lên thì trình duyệt không chạy được và site hỏng — nhưng deploy vẫn "thành
 * công", nên phải nói trước thay vì để người dùng tự đoán.
 *
 * @returns {string|null} ghi chú cảnh báo, null nếu trông như site chạy được
 */
function detectUnbuiltProject(files) {
  const hasConfig = files.some((f) => NEEDS_BUILD_FILE.test(f.path));
  const sourceFiles = files.filter((f) => SOURCE_ONLY_EXT.test(f.path));

  if (!hasConfig && sourceFiles.length === 0) return null;

  // Đã có sẵn thư mục build thì nhiều khả năng người dùng biết mình làm gì
  const looksBuilt = files.some((f) => /(^|\/)(dist|build|out|_site)\//i.test(f.path));
  if (looksBuilt) return null;

  const reason = hasConfig
    ? "có package.json hoặc file cấu hình build"
    : `có ${sourceFiles.length} file cần biên dịch (${sourceFiles[0].path})`;

  return (
    `Cảnh báo: source này ${reason}. Hosting tĩnh phục vụ file y nguyên, không ` +
    `chạy bước build — nếu trang cần biên dịch thì hãy chạy lệnh build ở máy rồi ` +
    `kéo thả thư mục kết quả (dist/, build/) thay vì source gốc.`
  );
}

/**
 * Hosting tĩnh phục vụ index.html khi người dùng vào "/". Nếu source không có
 * file nào tên đó, tự chọn một trang làm trang chủ thay vì bắt người dùng đổi
 * tên rồi kéo thả lại.
 *
 * Sửa `files` tại chỗ, trả về ghi chú để hiển thị (null nếu không phải làm gì).
 */
function ensureEntryPoint(files) {
  if (files.some((f) => f.path === "index.html")) return null;

  const rootHtml = files.filter((f) => !f.path.includes("/") && IS_HTML.test(f.path));

  if (rootHtml.length === 0) {
    const nested = files.find((f) => IS_HTML.test(f.path));
    throw new ValidationError(
      nested
        ? `Không có file HTML nào ở thư mục gốc. Tìm thấy "${nested.path}" nằm trong ` +
          `thư mục con — hãy kéo thả đúng thư mục chứa trang chủ.`
        : "Không có file HTML nào. Site tĩnh cần ít nhất một trang."
    );
  }

  // Chỉ một trang duy nhất: chắc chắn nó là trang chủ, đổi tên luôn.
  if (rootHtml.length === 1) {
    const only = rootHtml[0];
    const original = only.path;
    only.path = "index.html";
    return `Đã đổi tên "${original}" thành index.html để làm trang chủ.`;
  }

  // Nhiều trang: đoán theo tên quen thuộc, không có thì lấy trang đầu theo bảng chữ cái.
  const byName = (file) => file.path.replace(IS_HTML, "").toLowerCase();
  const sorted = [...rootHtml].sort((a, b) => a.path.localeCompare(b.path));
  const chosen = sorted.find((f) => HOME_NAMES.includes(byName(f))) || sorted[0];

  // Giữ nguyên file gốc vì các trang khác có thể đang link tới nó, chỉ thêm bản sao.
  files.push({ path: "index.html", content: chosen.content, bytes: chosen.bytes });

  return (
    `Không có index.html nên đã nhân bản "${chosen.path}" thành trang chủ. ` +
    `Đổi tên file bạn muốn làm trang chủ thành index.html rồi deploy lại nếu chọn nhầm.`
  );
}

/** Tên repo / service Render: chữ thường, số và dấu gạch ngang. */
export function slugify(name, fallback = "site") {
  const slug = String(name || "")
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

  return slug || fallback;
}
