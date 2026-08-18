/**
 * Kiểm tra một site có thật sự mở cho người lạ hay không.
 *
 * Cần thiết vì trạng thái do nhà cung cấp báo ("ready", "live") chỉ nói deploy
 * đã xong, không nói người ngoài xem được. Từ 28/07/2026 Netlify đặt project mới
 * ở chế độ private mặc định: deploy "ready" nhưng khách trả về 401. Render thì
 * service có thể đang bị suspend.
 *
 * Cách duy nhất biết chắc là tự mở URL đó mà không kèm token, đúng như một người
 * lạ, rồi xem trả về gì.
 */

const TIMEOUT_MS = 6000;
const BATCH_SIZE = 10;

/**
 * @returns {{checked: boolean, isPublic: boolean|null, status: number|null}}
 *   checked=false nghĩa là không kết luận được (mạng lỗi, quá hạn), khác hẳn với
 *   isPublic=false. Phân biệt hai cái này để giao diện không báo động giả.
 */
export async function checkPublicAccess(url) {
  if (!url) return { checked: false, isPublic: null, status: null };

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // Site private trả 401, hoặc chuyển hướng sang trang đăng nhập của nhà cung
    // cấp. Chỉ 2xx mới chắc chắn là khách xem được nội dung.
    return {
      checked: true,
      isPublic: res.status >= 200 && res.status < 300,
      status: res.status,
    };
  } catch {
    return { checked: false, isPublic: null, status: null };
  }
}

/**
 * Kiểm tra nhiều site cùng lúc, chia lô để không mở hàng trăm kết nối một lúc.
 * @param {string[]} urls
 * @returns {Promise<Map<string, {checked, isPublic, status}>>}
 */
export async function checkMany(urls) {
  const results = new Map();
  const unique = [...new Set(urls.filter(Boolean))];

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    const checked = await Promise.all(batch.map(checkPublicAccess));
    batch.forEach((url, index) => results.set(url, checked[index]));
  }

  return results;
}
