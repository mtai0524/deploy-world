/**
 * Giao diện kéo thả: gom file phía trình duyệt, mã hoá base64 rồi gửi một lần
 * cho /api/deploy, sau đó hỏi trạng thái cho tới khi hosting báo xong.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "deploy-world:creds";
  var COMBINING_MARKS = /[\u0300-\u036f]/g;
  var MAX_LISTED = 100;

  var picked = []; // [{ path, file }]
  var knownSites = []; // danh sach site da tai, dung de canh bao trung ten
  var polling = null;

  var el = {
    dropzone: document.getElementById("dropzone"),
    inputFolder: document.getElementById("input-folder"),
    inputFiles: document.getElementById("input-files"),
    pickFolder: document.getElementById("pick-folder"),
    pickFiles: document.getElementById("pick-files"),
    filelist: document.getElementById("filelist"),
    fileItems: document.getElementById("file-items"),
    fileSummary: document.getElementById("file-summary"),
    clearFiles: document.getElementById("clear-files"),
    modeTabs: document.querySelectorAll(".tab[data-mode]"),
    modePanels: document.querySelectorAll("[data-mode-panel]"),
    pastePanel: document.querySelector('[data-mode-panel="paste"]'),
    pasteArea: document.getElementById("paste-area"),
    gutter: document.getElementById("editor-gutter"),
    pasteInfo: document.getElementById("paste-info"),
    formatBtn: document.getElementById("format-btn"),
    clearPaste: document.getElementById("clear-paste"),
    expandBtn: document.getElementById("expand-btn"),
    previewBtn: document.getElementById("preview-btn"),
    modal: document.getElementById("code-modal"),
    modalTabs: document.querySelectorAll(".tab[data-view]"),
    modalPanels: document.querySelectorAll("[data-view-panel]"),
    modalArea: document.getElementById("modal-area"),
    modalGutter: document.getElementById("modal-gutter"),
    modalFormat: document.getElementById("modal-format"),
    modalInfo: document.getElementById("modal-info"),
    previewFrame: document.getElementById("preview-frame"),
    siteName: document.getElementById("site-name"),
    urlPreview: document.getElementById("url-preview"),
    urlSuffix: document.getElementById("url-suffix"),
    nameWarning: document.getElementById("name-warning"),
    providerRadios: document.querySelectorAll('input[name="provider"]'),
    providerSections: document.querySelectorAll("[data-provider]"),
    nfToken: document.getElementById("nf-token"),
    ghToken: document.getElementById("gh-token"),
    rdKey: document.getElementById("rd-key"),
    remember: document.getElementById("remember-keys"),
    overwrite: document.getElementById("overwrite-existing"),
    makePublic: document.getElementById("make-public"),
    credsNote: document.getElementById("creds-note"),
    deployBtn: document.getElementById("deploy-btn"),
    deployHint: document.getElementById("deploy-hint"),
    progressPanel: document.getElementById("progress-panel"),
    steps: document.getElementById("steps"),
    result: document.getElementById("result"),
    refreshSites: document.getElementById("refresh-sites"),
    sitesNote: document.getElementById("sites-note"),
    sitesList: document.getElementById("sites-list"),
    deleteModal: document.getElementById("delete-modal"),
    deleteName: document.getElementById("delete-name"),
    deleteUrl: document.getElementById("delete-url"),
    deleteConfirm: document.getElementById("delete-confirm"),
    deleteError: document.getElementById("delete-error"),
    deleteGo: document.getElementById("delete-go"),
  };

  /* ------------------------- Tiện ích chung ------------------------- */

  // Giữ cùng luật với slugify phía server để URL xem trước khớp kết quả thật
  function slugify(name) {
    return String(name || "")
      .normalize("NFD")
      .replace(COMBINING_MARKS, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "");
  }

  function humanSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = String(text == null ? "" : text);
    return div.innerHTML;
  }

  function readAsBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        // dataURL có dạng "data:mime;base64,xxxx" - chỉ lấy phần sau dấu phẩy
        var result = String(reader.result);
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = function () {
        reject(new Error("Không đọc được file " + file.name));
      };
      reader.readAsDataURL(file);
    });
  }

  /* --------------------- Thu thập file kéo thả ---------------------- */

  // readEntries chỉ trả tối đa 100 mục mỗi lần nên phải gọi lặp tới khi rỗng
  function readAllEntries(reader) {
    return new Promise(function (resolve, reject) {
      var all = [];
      (function next() {
        reader.readEntries(function (batch) {
          if (!batch.length) return resolve(all);
          all = all.concat(batch);
          next();
        }, reject);
      })();
    });
  }

  function walkEntry(entry, prefix, out) {
    if (entry.isFile) {
      return new Promise(function (resolve, reject) {
        entry.file(function (file) {
          out.push({ path: prefix + entry.name, file: file });
          resolve();
        }, reject);
      });
    }

    if (entry.isDirectory) {
      return readAllEntries(entry.createReader()).then(function (children) {
        return children.reduce(function (chain, child) {
          return chain.then(function () {
            return walkEntry(child, prefix + entry.name + "/", out);
          });
        }, Promise.resolve());
      });
    }

    return Promise.resolve();
  }

  function collectFromDrop(dataTransfer) {
    var entries = [];
    for (var i = 0; i < dataTransfer.items.length; i++) {
      var entry = dataTransfer.items[i].webkitGetAsEntry
        ? dataTransfer.items[i].webkitGetAsEntry()
        : null;
      if (entry) entries.push(entry);
    }

    // Trình duyệt không hỗ trợ webkitGetAsEntry: rơi về danh sách file phẳng
    if (!entries.length) {
      return Promise.resolve(
        Array.prototype.map.call(dataTransfer.files, function (file) {
          return { path: file.name, file: file };
        })
      );
    }

    var out = [];
    return entries
      .reduce(function (chain, entry) {
        return chain.then(function () {
          return walkEntry(entry, "", out);
        });
      }, Promise.resolve())
      .then(function () {
        return out;
      });
  }

  function collectFromInput(input) {
    return Array.prototype.map.call(input.files, function (file) {
      return { path: file.webkitRelativePath || file.name, file: file };
    });
  }

  /* --------------------------- Hiển thị ----------------------------- */

  // Kéo cả folder thì tên folder là gợi ý tên site tự nhiên nhất
  function guessSiteName(files) {
    var first = files[0] && files[0].path;
    return first && first.indexOf("/") !== -1 ? slugify(first.split("/")[0]) : "";
  }

  function renderFiles() {
    if (!picked.length) {
      el.filelist.hidden = true;
      el.fileItems.innerHTML = "";
      updateDeployState();
      return;
    }

    var total = picked.reduce(function (sum, item) {
      return sum + item.file.size;
    }, 0);

    el.fileSummary.textContent = picked.length + " file · " + humanSize(total);
    el.fileItems.innerHTML = "";

    picked.slice(0, MAX_LISTED).forEach(function (item) {
      var li = document.createElement("li");
      // Tô đậm file sẽ thành trang chủ để nhìn phát biết chọn đúng chưa
      if (/(^|\/)index\.html$/i.test(item.path)) li.className = "is-entry";

      var name = document.createElement("span");
      name.textContent = item.path;
      var size = document.createElement("span");
      size.textContent = humanSize(item.file.size);

      li.appendChild(name);
      li.appendChild(size);
      el.fileItems.appendChild(li);
    });

    if (picked.length > MAX_LISTED) {
      var more = document.createElement("li");
      more.textContent = "... và " + (picked.length - MAX_LISTED) + " file nữa";
      el.fileItems.appendChild(more);
    }

    el.filelist.hidden = false;
    updateDeployState();
  }

  function setFiles(files) {
    picked = files;

    if (!el.siteName.value) {
      el.siteName.value = guessSiteName(picked);
      updateUrlPreview();
      checkNameCollision();
    }
    renderFiles();
  }

  /* ------------------------- Chế độ dán code ------------------------ */

  function currentMode() {
    return el.pastePanel && !el.pastePanel.hidden ? "paste" : "drop";
  }

  function setMode(mode) {
    el.modeTabs.forEach(function (tab) {
      var active = tab.getAttribute("data-mode") === mode;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    el.modePanels.forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-mode-panel") !== mode;
    });
    updateDeployState();
  }

  /**
   * Tab trong ô soạn thảo phải là thụt lề, không phải nhảy sang nút kế tiếp.
   * @returns {boolean} true nếu đã chèn, để phía gọi biết mà vẽ lại số dòng
   */
  function insertTab(event, textarea) {
    if (event.key !== "Tab") return false;
    event.preventDefault();

    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var value = textarea.value;

    textarea.value = value.slice(0, start) + "  " + value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + 2;
    return true;
  }

  function updatePasteInfo() {
    var text = el.pasteArea.value;
    if (!text.trim()) {
      el.pasteInfo.textContent = "Trống";
      return;
    }
    var bytes = new TextEncoder().encode(text).length;
    el.pasteInfo.textContent =
      text.split("\n").length + " dòng · " + humanSize(bytes);
  }

  function onPasteChanged() {
    renderGutter(el.gutter, el.pasteArea);
    updatePasteInfo();
    updateDeployState();
  }

  /** btoa chỉ nhận latin1, nên phải mã hoá UTF-8 thành byte trước. */
  function textToBase64(text) {
    var bytes = new TextEncoder().encode(text);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /* ------------------- Popup xem full / xem trước ------------------- */

  function renderGutter(gutterEl, textarea) {
    var lines = textarea.value.split("\n").length;
    var numbers = [];
    for (var i = 1; i <= lines; i++) numbers.push(i);
    gutterEl.textContent = numbers.join("\n");
    gutterEl.scrollTop = textarea.scrollTop;
  }

  function setModalView(view) {
    el.modalTabs.forEach(function (tab) {
      var active = tab.getAttribute("data-view") === view;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    el.modalPanels.forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-view-panel") !== view;
    });

    // Nạp lại preview mỗi lần mở tab, để nó luôn khớp code hiện tại
    if (view === "preview") {
      el.previewFrame.srcdoc = el.modalArea.value;
      el.modalInfo.textContent =
        "Preview chạy trong iframe cách ly, không đọc được dữ liệu của trang này.";
    } else {
      el.modalInfo.textContent = "Sửa ở đây thì ô bên ngoài cập nhật theo.";
    }
  }

  function openModal(view) {
    el.modalArea.value = el.pasteArea.value;
    renderGutter(el.modalGutter, el.modalArea);

    el.modal.hidden = false;
    document.body.classList.add("modal-open");
    setModalView(view || "code");

    if (view !== "preview") el.modalArea.focus();
  }

  function closeModal() {
    el.modal.hidden = true;
    document.body.classList.remove("modal-open");
    // Bỏ nội dung preview để script bên trong ngừng chạy khi đóng popup
    el.previewFrame.srcdoc = "";
  }

  function isModalOpen() {
    return !el.modal.hidden;
  }

  /* -------------------------- Nhà cung cấp -------------------------- */

  var PROVIDERS = {
    netlify: { suffix: ".netlify.app", key: function () { return el.nfToken.value; } },
    render: { suffix: ".onrender.com", key: function () { return el.rdKey.value; } },
  };

  function currentProvider() {
    for (var i = 0; i < el.providerRadios.length; i++) {
      if (el.providerRadios[i].checked) return el.providerRadios[i].value;
    }
    return "netlify";
  }

  // Mỗi khối cấu hình gắn data-provider, chỉ hiện khối đúng với lựa chọn
  function syncProviderUi() {
    var active = currentProvider();

    el.providerSections.forEach(function (section) {
      section.hidden = section.getAttribute("data-provider") !== active;
    });

    el.urlSuffix.textContent = PROVIDERS[active].suffix;
  }

  function updateUrlPreview() {
    el.urlPreview.textContent = slugify(el.siteName.value) || "ten-site";
  }

  /**
   * Báo trước khi bấm Deploy nếu tên vừa gõ trùng một site đã có.
   * Server vẫn chặn lần nữa — đây chỉ là lớp báo sớm, không thay thế nó.
   */
  function checkNameCollision() {
    var name = slugify(el.siteName.value);

    var clash = name
      ? knownSites.filter(function (site) {
          return site.name === name;
        })[0]
      : null;

    if (!clash) {
      el.nameWarning.hidden = true;
      el.nameWarning.textContent = "";
      return;
    }

    el.nameWarning.hidden = false;
    el.nameWarning.textContent = el.overwrite.checked
      ? 'Trùng tên với site "' + clash.name + '" đang có. Đã bật ghi đè nên nội dung cũ sẽ bị thay.'
      : 'Đã có site tên "' + clash.name + '". Deploy sẽ dừng lại trừ khi bạn bật "Ghi đè nếu trùng tên", hoặc đổi sang tên khác.';
  }

  // Trang ở gốc, hoặc ngay trong thư mục bọc ngoài (server sẽ bóc lớp đó ra)
  function rootPages() {
    return picked.filter(function (item) {
      var parts = item.path.split("/");
      return /\.html?$/i.test(parts[parts.length - 1]) && parts.length <= 2;
    });
  }

  function updateDeployState() {
    if (currentMode() === "paste") {
      var text = el.pasteArea.value;
      var hasHtml = /<[a-z!][\s\S]*>/i.test(text);

      el.deployBtn.disabled = !text.trim();

      if (!text.trim()) el.deployHint.textContent = "Dán HTML vào ô bên trên";
      else if (!hasHtml) el.deployHint.textContent = "Nội dung không có thẻ HTML nào — vẫn deploy được";
      else el.deployHint.textContent = "Sẵn sàng deploy thành index.html";
      return;
    }

    var hasFiles = picked.length > 0;
    var pages = rootPages();
    var hasIndex = pages.some(function (item) {
      return /(^|\/)index\.html$/i.test(item.path);
    });

    // Chỉ cần có ít nhất một trang HTML — không có index.html thì server tự chọn
    el.deployBtn.disabled = !hasFiles || pages.length === 0;

    if (!hasFiles) {
      el.deployHint.textContent = "Chọn source trước đã";
    } else if (pages.length === 0) {
      el.deployHint.textContent = "Chưa có file HTML nào ở thư mục gốc";
    } else if (hasIndex) {
      el.deployHint.textContent = picked.length + " file sẵn sàng";
    } else if (pages.length === 1) {
      el.deployHint.textContent =
        picked.length + " file sẵn sàng — " + pages[0].path + " sẽ thành trang chủ";
    } else {
      el.deployHint.textContent =
        picked.length + " file sẵn sàng — chưa có index.html, server sẽ tự chọn trang chủ";
    }
  }

  function addStep(label, state) {
    var li = document.createElement("li");
    li.className = state || "run";

    var mark = document.createElement("span");
    mark.className = "mark";
    if (state === "ok") mark.textContent = "✓";
    else if (state === "fail") mark.textContent = "✕";
    else if (state === "note") mark.textContent = "•";
    else {
      mark.textContent = "◌";
      mark.classList.add("spin");
    }

    var text = document.createElement("span");
    text.textContent = label;

    li.appendChild(mark);
    li.appendChild(text);
    el.steps.appendChild(li);
    return li;
  }

  function finishStep(stepEl, state, label) {
    stepEl.className = state;
    stepEl.firstChild.className = "mark";
    stepEl.firstChild.textContent =
      state === "ok" ? "✓" : state === "fail" ? "✕" : "•";
    stepEl.lastChild.textContent = label;
  }

  function linkHtml(url, label) {
    if (!url) return "";
    return (
      '<p><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' +
      escapeHtml(label) +
      "</a></p>"
    );
  }

  function showResult(kind, html) {
    el.result.className = "result " + kind;
    el.result.innerHTML = html;
    el.result.hidden = false;
  }

  /* --------------------------- Lưu khoá ----------------------------- */

  function loadCreds() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (saved.netlifyToken) el.nfToken.value = saved.netlifyToken;
      if (saved.githubToken) el.ghToken.value = saved.githubToken;
      if (saved.renderApiKey) el.rdKey.value = saved.renderApiKey;
      if (saved.provider) {
        el.providerRadios.forEach(function (radio) {
          radio.checked = radio.value === saved.provider;
        });
      }
    } catch (error) {
      /* localStorage hỏng thì người dùng nhập lại, không cần báo lỗi */
    }
  }

  function saveCreds() {
    if (!el.remember.checked) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          provider: currentProvider(),
          netlifyToken: el.nfToken.value,
          githubToken: el.ghToken.value,
          renderApiKey: el.rdKey.value,
        })
      );
    } catch (error) {
      /* hết quota thì bỏ qua */
    }
  }

  /* ----------------------- Danh sách site --------------------------- */

  function formatDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function renderSites(sites) {
    knownSites = sites;
    checkNameCollision();
    el.sitesList.innerHTML = "";

    if (!sites.length) {
      el.sitesNote.textContent = "Chưa có site nào trong tài khoản này.";
      return;
    }

    var privateCount = sites.filter(function (s) {
      return s.accessChecked && s.isPublic === false;
    }).length;

    el.sitesNote.textContent =
      sites.length + " site trong tài khoản " + currentProvider() +
      (privateCount
        ? " — " + privateCount + " site đang private, người lạ chưa xem được"
        : "");

    sites.forEach(function (site) {
      var li = document.createElement("li");

      var main = document.createElement("div");
      main.className = "site-main";

      var name = document.createElement("strong");
      name.textContent = site.name;
      main.appendChild(name);

      // Trạng thái "ready" không đồng nghĩa khách xem được — server đã tự mở URL
      // không kèm token để biết chắc, hiện kết quả đó ra đây.
      var badge = document.createElement("span");
      if (!site.accessChecked) {
        badge.className = "badge badge-unknown";
        badge.textContent = "chưa rõ";
        badge.title = "Không kiểm tra được (mạng lỗi hoặc quá hạn chờ)";
      } else if (site.isPublic) {
        badge.className = "badge badge-public";
        badge.textContent = "public";
        badge.title = "Người lạ mở link này xem được";
      } else {
        badge.className = "badge badge-private";
        badge.textContent = "private";
        badge.title = "Người lạ mở link này bị chặn — vào dashboard bấm Make public";
      }
      main.appendChild(badge);

      if (site.url) {
        var link = document.createElement("a");
        link.href = site.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = site.url.replace(/^https?:\/\//, "");
        main.appendChild(link);
      }

      var meta = document.createElement("div");
      meta.className = "site-meta";

      var when = formatDate(site.updatedAt);
      meta.textContent = [site.state, when].filter(Boolean).join(" · ");

      var dash = site.adminUrl || site.dashboardUrl;
      if (dash) {
        var dashLink = document.createElement("a");
        dashLink.href = dash;
        dashLink.target = "_blank";
        dashLink.rel = "noopener";
        dashLink.textContent = "dashboard";
        meta.appendChild(document.createTextNode(" · "));
        meta.appendChild(dashLink);
      }

      var del = document.createElement("button");
      del.type = "button";
      del.className = "linkish linkish-danger";
      del.textContent = "xoá";
      del.addEventListener("click", function () {
        openDeleteModal(site);
      });
      meta.appendChild(document.createTextNode(" · "));
      meta.appendChild(del);

      li.appendChild(main);
      li.appendChild(meta);
      el.sitesList.appendChild(li);
    });
  }

  /* --------------------------- Xoá site ----------------------------- */

  var pendingDelete = null;

  function openDeleteModal(site) {
    pendingDelete = site;

    el.deleteName.textContent = site.name;
    el.deleteUrl.textContent = site.url || "";
    el.deleteConfirm.value = "";
    el.deleteError.hidden = true;
    el.deleteGo.disabled = true;

    el.deleteModal.hidden = false;
    document.body.classList.add("modal-open");
    el.deleteConfirm.focus();
  }

  function closeDeleteModal() {
    el.deleteModal.hidden = true;
    document.body.classList.remove("modal-open");
    pendingDelete = null;
  }

  function runDelete() {
    if (!pendingDelete) return;

    var provider = currentProvider();
    var key = PROVIDERS[provider].key();

    el.deleteGo.disabled = true;
    el.deleteGo.textContent = "Đang xoá...";
    el.deleteError.hidden = true;

    fetch(
      "/api/sites/" + provider + "/" + encodeURIComponent(pendingDelete.id) +
        "?confirmName=" + encodeURIComponent(pendingDelete.name),
      { method: "DELETE", headers: key ? { "x-provider-key": key } : {} }
    )
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        el.deleteGo.textContent = "Xoá vĩnh viễn";

        if (!data.ok) {
          el.deleteError.textContent = data.error;
          el.deleteError.hidden = false;
          el.deleteGo.disabled = false;
          return;
        }

        var name = data.deleted;
        closeDeleteModal();
        loadSites();
        el.sitesNote.textContent = 'Đã xoá site "' + name + '".';
      })
      .catch(function (error) {
        el.deleteGo.textContent = "Xoá vĩnh viễn";
        el.deleteGo.disabled = false;
        el.deleteError.textContent = "Không xoá được: " + error.message;
        el.deleteError.hidden = false;
      });
  }

  function loadSites() {
    var provider = currentProvider();
    var key = PROVIDERS[provider].key();

    el.sitesList.innerHTML = "";

    // Không có khoá thì server vẫn có thể dùng khoá mặc định của nó, cứ thử gọi
    el.sitesNote.textContent = "Đang tải...";

    fetch("/api/sites/" + provider, {
      headers: key ? { "x-provider-key": key } : {},
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (!data.ok) {
          el.sitesNote.textContent = data.error;
          return;
        }
        renderSites(data.sites || []);
      })
      .catch(function (error) {
        el.sitesNote.textContent = "Không tải được danh sách: " + error.message;
      });
  }

  /* ---------------------------- Deploy ------------------------------ */

  function pollDeploy(provider, siteId, deployId, key, stepEl) {
    var attempts = 0;
    var MAX_ATTEMPTS = 150; // 150 x 3s = 7,5 phút

    return new Promise(function (resolve) {
      polling = setInterval(function () {
        attempts++;
        if (attempts > MAX_ATTEMPTS) {
          clearInterval(polling);
          resolve({ timedOut: true });
          return;
        }

        fetch("/api/deploy/" + provider + "/" + siteId + "/" + deployId, {
          headers: key ? { "x-provider-key": key } : {},
        })
          .then(function (res) {
            return res.json();
          })
          .then(function (data) {
            if (!data.ok) return;
            stepEl.lastChild.textContent = "Đang xử lý - trạng thái: " + data.status;
            if (data.finished) {
              clearInterval(polling);
              resolve(data);
            }
          })
          .catch(function () {
            /* mạng chập chờn thì để vòng sau thử lại */
          });
      }, 3000);
    });
  }

  function reportSuccess(data, final) {
    var siteUrl = (final && final.siteUrl) || data.siteUrl;
    var dashUrl = (final && final.dashboardUrl) || data.dashboardUrl;

    // Netlify đặt project mới ở chế độ private mặc định — deploy xong vẫn chỉ
    // thành viên team xem được, nên phải nói rõ thay vì báo "lên sóng" rồi thôi.
    var isPrivate = final && final.accessChecked && final.isPublic === false;

    showResult(
      "ok",
      "<h3>" + (isPrivate ? "Deploy xong, nhưng site đang private" : "Site đã lên sóng") + "</h3>" +
        (siteUrl
          ? '<p><a class="site-link" href="' + escapeHtml(siteUrl) +
            '" target="_blank" rel="noopener">' + escapeHtml(siteUrl) + "</a></p>"
          : "<p>Hosting chưa trả về URL, kiểm tra trên dashboard.</p>") +
        (isPrivate
          ? '<p class="hint warn">Người lạ mở link này chưa xem được. Netlify đặt mọi ' +
            "project mới ở chế độ private từ 28/07/2026. Vào dashboard bấm " +
            "<strong>Make public</strong>, hoặc Project configuration → General → " +
            "Visitor access → Project visibility → Public.</p>" +
            '<p class="hint">Muốn khỏi lặp lại mỗi lần deploy: Team settings → General → ' +
            "Visitor access → Default project visibility → Public.</p>"
          : "") +
        linkHtml(data.repoUrl, "Repo GitHub") +
        linkHtml(dashUrl, isPrivate ? "Mở dashboard để bật public" : "Mở dashboard") +
        '<p class="hint">Deploy lại với cùng tên site sẽ ghi đè site này.</p>'
    );
  }

  /** Gom nguồn file theo chế độ đang chọn, trả về cùng một dạng cho cả hai. */
  function collectFiles() {
    if (currentMode() === "paste") {
      // Server tự đổi tên trang duy nhất thành index.html, nhưng đặt sẵn ở đây
      // cho khớp với dòng ghi chú hiển thị trên giao diện.
      return Promise.resolve([
        { path: "index.html", content: textToBase64(el.pasteArea.value) },
      ]);
    }

    return Promise.all(
      picked.map(function (item) {
        return readAsBase64(item.file).then(function (content) {
          return { path: item.path, content: content };
        });
      })
    );
  }

  function deploy() {
    if (polling) clearInterval(polling);

    el.deployBtn.disabled = true;
    el.progressPanel.hidden = false;
    el.steps.innerHTML = "";
    el.result.hidden = true;
    el.progressPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });

    saveCreds();

    var pasting = currentMode() === "paste";
    var readStep = addStep(
      pasting ? "Đang đóng gói code đã dán..." : "Đang đọc " + picked.length + " file..."
    );

    collectFiles()
      .then(function (files) {
        finishStep(
          readStep,
          "ok",
          pasting ? "Đã đóng gói thành index.html" : "Đã đọc " + files.length + " file"
        );
        var uploadStep = addStep("Đang gửi file lên hosting...");

        return fetch("/api/deploy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: currentProvider(),
            siteName: el.siteName.value,
            overwriteExisting: el.overwrite.checked,
            makeRepoPublic: el.makePublic.checked,
            files: files,
            netlifyToken: el.nfToken.value || undefined,
            githubToken: el.ghToken.value || undefined,
            renderApiKey: el.rdKey.value || undefined,
          }),
        })
          .then(function (res) {
            return res.json();
          })
          .then(function (data) {
            uploadStep.remove();
            return data;
          });
      })
      .then(function (data) {
        if (!data.ok) {
          // Server có thể trả nhiều rào cản một lúc; tách ra cho dễ đọc
          var reasons = Array.isArray(data.detail) ? data.detail : [data.error];

          reasons.forEach(function (reason) {
            addStep(reason, "fail");
          });

          showResult(
            "fail",
            "<h3>Deploy thất bại</h3>" +
              reasons
                .map(function (reason) {
                  return "<p>" + escapeHtml(reason) + "</p>";
                })
                .join("")
          );
          el.deployBtn.disabled = false;
          return;
        }

        (data.steps || []).forEach(function (step) {
          addStep(step.label, "ok");
        });
        (data.notes || []).forEach(function (note) {
          addStep(note, "note");
        });

        var buildStep = addStep("Đang chờ hosting xử lý...");

        return pollDeploy(
          data.provider,
          data.siteId,
          data.deployId,
          PROVIDERS[data.provider].key(),
          buildStep
        ).then(
          function (final) {
            if (final && final.timedOut) {
              finishStep(buildStep, "note", "Lâu hơn dự kiến - theo dõi tiếp trên dashboard của hosting");
              reportSuccess(data, final);
            } else if (final && final.failed) {
              finishStep(buildStep, "fail", "Build thất bại (" + final.status + ")");
              showResult(
                "fail",
                "<h3>Deploy thất bại</h3><p>Xem log chi tiết trên dashboard.</p>" +
                  linkHtml(final.dashboardUrl || data.dashboardUrl, "Mở dashboard") +
                  linkHtml(data.repoUrl, "Xem repo GitHub")
              );
            } else {
              finishStep(buildStep, "ok", "Build xong, site đã live");
              reportSuccess(data, final);
            }
            el.deployBtn.disabled = false;

            loadSites(); // site vua deploy xuat hien ngay trong danh sach
          }
        );
      })
      .catch(function (error) {
        addStep(error.message || "Lỗi không xác định", "fail");
        showResult("fail", "<h3>Có lỗi xảy ra</h3><p>" + escapeHtml(error.message) + "</p>");
        el.deployBtn.disabled = false;
      });
  }

  /* ---------------------------- Sự kiện ----------------------------- */

  el.dropzone.addEventListener("click", function (event) {
    if (event.target.tagName !== "BUTTON") el.inputFolder.click();
  });

  el.dropzone.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      el.inputFolder.click();
    }
  });

  ["dragenter", "dragover"].forEach(function (name) {
    el.dropzone.addEventListener(name, function (event) {
      event.preventDefault();
      el.dropzone.classList.add("is-over");
    });
  });

  ["dragleave", "drop"].forEach(function (name) {
    el.dropzone.addEventListener(name, function (event) {
      event.preventDefault();
      el.dropzone.classList.remove("is-over");
    });
  });

  el.dropzone.addEventListener("drop", function (event) {
    collectFromDrop(event.dataTransfer).then(setFiles);
  });

  el.pickFolder.addEventListener("click", function () {
    el.inputFolder.click();
  });

  el.pickFiles.addEventListener("click", function () {
    el.inputFiles.click();
  });

  el.inputFolder.addEventListener("change", function () {
    setFiles(collectFromInput(el.inputFolder));
  });

  el.inputFiles.addEventListener("change", function () {
    setFiles(collectFromInput(el.inputFiles));
  });

  el.clearFiles.addEventListener("click", function () {
    picked = [];
    el.inputFolder.value = "";
    el.inputFiles.value = "";
    renderFiles();
  });

  el.modeTabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      setMode(tab.getAttribute("data-mode"));
    });
  });

  el.pasteArea.addEventListener("input", onPasteChanged);
  el.pasteArea.addEventListener("scroll", function () {
    el.gutter.scrollTop = el.pasteArea.scrollTop;
  });

  el.pasteArea.addEventListener("keydown", function (event) {
    if (insertTab(event, el.pasteArea)) onPasteChanged();
  });

  el.formatBtn.addEventListener("click", function () {
    if (!el.pasteArea.value.trim()) return;
    el.pasteArea.value = window.DW.formatHtml(el.pasteArea.value);
    onPasteChanged();
  });

  el.clearPaste.addEventListener("click", function () {
    el.pasteArea.value = "";
    onPasteChanged();
  });

  el.expandBtn.addEventListener("click", function () {
    openModal("code");
  });

  el.previewBtn.addEventListener("click", function () {
    openModal("preview");
  });

  el.modalTabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      setModalView(tab.getAttribute("data-view"));
    });
  });

  // Sửa trong popup thì ô ngoài cập nhật theo, hai bên luôn cùng một nội dung
  el.modalArea.addEventListener("input", function () {
    el.pasteArea.value = el.modalArea.value;
    renderGutter(el.modalGutter, el.modalArea);
    onPasteChanged();
  });

  el.modalArea.addEventListener("scroll", function () {
    el.modalGutter.scrollTop = el.modalArea.scrollTop;
  });

  el.modalArea.addEventListener("keydown", function (event) {
    if (insertTab(event, el.modalArea)) {
      renderGutter(el.modalGutter, el.modalArea);
      onPasteChanged();
    }
  });

  el.modalFormat.addEventListener("click", function () {
    if (!el.modalArea.value.trim()) return;
    el.modalArea.value = window.DW.formatHtml(el.modalArea.value);
    el.pasteArea.value = el.modalArea.value;
    renderGutter(el.modalGutter, el.modalArea);
    onPasteChanged();
  });

  // Bấm nền mờ hoặc nút Đóng đều thoát
  el.modal.addEventListener("click", function (event) {
    if (event.target.hasAttribute("data-close-modal")) closeModal();
  });

  // Nút Xoá chỉ mở khi tên gõ vào khớp tuyệt đối — server vẫn kiểm lại lần nữa
  el.deleteConfirm.addEventListener("input", function () {
    var typed = el.deleteConfirm.value.trim();
    el.deleteGo.disabled = !pendingDelete || typed !== pendingDelete.name;
  });

  el.deleteConfirm.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !el.deleteGo.disabled) runDelete();
  });

  el.deleteGo.addEventListener("click", runDelete);

  el.deleteModal.addEventListener("click", function (event) {
    if (event.target.hasAttribute("data-close-delete")) closeDeleteModal();
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (!el.deleteModal.hidden) closeDeleteModal();
    else if (isModalOpen()) closeModal();
  });

  el.siteName.addEventListener("input", function () {
    updateUrlPreview();
    checkNameCollision();
  });

  el.overwrite.addEventListener("change", checkNameCollision);
  el.deployBtn.addEventListener("click", deploy);

  el.providerRadios.forEach(function (radio) {
    radio.addEventListener("change", function () {
      syncProviderUi();
      loadSites();
    });
  });

  el.refreshSites.addEventListener("click", loadSites);

  // Nhập xong khoá thì tải luôn danh sách, khỏi phải bấm Tải lại
  [el.nfToken, el.rdKey].forEach(function (input) {
    input.addEventListener("change", function () {
      if (input.value) loadSites();
    });
  });

  /* --------------------------- Khởi động ---------------------------- */

  loadCreds();
  syncProviderUi(); // phải chạy sau loadCreds vì nó khôi phục lựa chọn đã lưu
  updateUrlPreview();
  onPasteChanged();
  updateDeployState();
  checkNameCollision();

  // Đã có khoá lưu sẵn thì hiện danh sách ngay, khỏi bắt bấm Tải lại
  if (PROVIDERS[currentProvider()].key()) loadSites();

  // Server có sẵn key thì đổi lời nhắc, không bắt người dùng phải nhập
  fetch("/api/config")
    .then(function (res) {
      return res.json();
    })
    .then(function (config) {
      var ready = Object.keys(config.providers || {}).filter(function (name) {
        return config.providers[name].hasServerKey;
      });

      if (ready.length) {
        el.credsNote.textContent =
          "Server đã có khoá mặc định cho: " + ready.join(", ") +
          ". Để trống nếu muốn deploy vào tài khoản của server, hoặc nhập khoá riêng " +
          "để deploy vào tài khoản của bạn.";
      }
    })
    .catch(function () {
      /* không lấy được cấu hình cũng không ảnh hưởng luồng chính */
    });
})();
