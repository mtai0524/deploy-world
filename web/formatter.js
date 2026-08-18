/**
 * Bộ định dạng HTML tối giản, không phụ thuộc thư viện ngoài.
 *
 * Mục tiêu là làm code dán vào dễ đọc, không phải viết lại một parser HTML đầy
 * đủ. Nên nó cố tình bảo thủ: chỗ nào không chắc thì giữ nguyên thay vì đoán.
 *
 * Nội dung của pre/textarea/script/style được tháo ra giữ nguyên trước khi thụt
 * lề, vì khoảng trắng trong đó có ý nghĩa (pre) hoặc thụt sai sẽ làm hỏng code.
 */
(function (root) {
  "use strict";

  // Thẻ rỗng, không có thẻ đóng nên không được tăng mức thụt lề
  var VOID_TAGS = [
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
  ];

  // Thẻ mà nội dung bên trong phải giữ nguyên từng ký tự
  var RAW_TAGS = ["pre", "textarea", "script", "style"];

  var INDENT = "  ";

  // Token đánh dấu chỗ đã tháo khối raw ra. Cố tình chỉ dùng chữ hoa ASCII:
  // ký tự điều khiển hay ký hiệu lạ dễ bị công cụ chỉnh sửa file làm hỏng.
  var TOKEN_HEAD = "RAWBLOCK";
  var TOKEN_TAIL = "ENDRAWBLOCK";
  var TOKEN_LINE = new RegExp("^([ \\t]*)" + TOKEN_HEAD + "(\\d+)" + TOKEN_TAIL + "[ \\t]*$", "gm");

  function isVoid(tagName) {
    return VOID_TAGS.indexOf(tagName) !== -1;
  }

  /** Lấy tên thẻ từ một chuỗi dạng "<div class=...>" */
  function tagNameOf(token) {
    var match = /^<\/?\s*([a-zA-Z0-9-]+)/.exec(token);
    return match ? match[1].toLowerCase() : "";
  }

  /**
   * Tháo nội dung raw ra ngoài, thay bằng token để bước thụt lề không đụng vào.
   * Token được bọc newline để nó nằm trên một dòng riêng — bước khôi phục chỉ
   * nhận ra nó khi nó đứng một mình, dính vào thẻ bao là mất khối raw.
   */
  function extractRawBlocks(html, store) {
    var pattern = new RegExp(
      "<(" + RAW_TAGS.join("|") + ")([^>]*)>([\\s\\S]*?)<\\/\\1\\s*>",
      "gi"
    );

    return html.replace(pattern, function (match, tag, attrs, inner) {
      var index = store.length;
      store.push({ tag: tag.toLowerCase(), attrs: attrs, inner: inner });
      return "\n" + TOKEN_HEAD + index + TOKEN_TAIL + "\n";
    });
  }

  /** Bỏ thụt lề chung của một khối code rồi thụt lại theo mức hiện tại. */
  function reindentBlock(text, indent) {
    var lines = text.replace(/^\s*\n/, "").replace(/\s+$/, "").split("\n");
    if (!lines.length) return "";

    var common = null;
    lines.forEach(function (line) {
      if (!line.trim()) return;
      var lead = /^[ \t]*/.exec(line)[0].length;
      if (common === null || lead < common) common = lead;
    });
    common = common || 0;

    return lines
      .map(function (line) {
        return line.trim() ? indent + line.slice(common) : "";
      })
      .join("\n");
  }

  function restoreRawBlocks(text, store) {
    return text.replace(TOKEN_LINE, function (line, indent, index) {
      var block = store[Number(index)];
      var open = indent + "<" + block.tag + block.attrs + ">";
      var close = indent + "</" + block.tag + ">";

      // pre/textarea giữ nguyên tuyệt đối vì khoảng trắng trong đó hiển thị ra
      // màn hình; script/style thì thụt lại cho thẳng hàng với thẻ bao.
      var inner =
        block.tag === "pre" || block.tag === "textarea"
          ? block.inner.replace(/^\n/, "").replace(/\s+$/, "")
          : reindentBlock(block.inner, indent + INDENT);

      if (!inner.trim()) return open + close;
      return open + "\n" + inner + "\n" + close;
    });
  }

  /**
   * @param {string} source HTML thô
   * @returns {string} HTML đã thụt lề
   */
  function formatHtml(source) {
    if (!source || !source.trim()) return "";

    var rawBlocks = [];
    var html = extractRawBlocks(String(source), rawBlocks);

    // Tách mỗi thẻ thành một dòng riêng. Text nằm giữa hai thẻ trên cùng dòng
    // (<p>xin chào</p>) được giữ nguyên chứ không tách ra.
    html = html
      .replace(/\r\n?/g, "\n")
      .replace(/>\s*</g, ">\n<")
      .replace(/^\s+|\s+$/g, "");

    var depth = 0;
    var out = [];

    html.split("\n").forEach(function (rawLine) {
      var line = rawLine.trim();
      if (!line) return;

      var isClosing = /^<\//.test(line);
      var isDoctype = /^<!(doctype|--)/i.test(line);
      var isSelfClosed = /\/>\s*$/.test(line);
      var tag = tagNameOf(line);

      // Thẻ đóng lùi vào trước khi in, để nó thẳng hàng với thẻ mở tương ứng
      if (isClosing) depth = Math.max(0, depth - 1);

      out.push(new Array(depth + 1).join(INDENT) + line);

      var opensBlock =
        !isClosing &&
        !isDoctype &&
        !isSelfClosed &&
        /^</.test(line) &&
        tag &&
        !isVoid(tag) &&
        // Mở và đóng gọn trên cùng một dòng thì không tính là mở khối mới
        line.indexOf("</" + tag) === -1;

      if (opensBlock) depth++;
    });

    return restoreRawBlocks(out.join("\n"), rawBlocks) + "\n";
  }

  root.formatHtml = formatHtml;
})(typeof module !== "undefined" && module.exports ? module.exports : (window.DW = window.DW || {}));
