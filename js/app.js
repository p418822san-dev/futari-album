/**
 * ふたりアルバム 画面・表示ロジック
 * 保存処理はすべて storage（js/storage.js のアダプタ）経由で行う。
 */
(function () {
  "use strict";

  const U = window.AlbumUtils;
  const CONFIG = window.ALBUM_CONFIG;

  // 「この端末だけで試す」を押したタブでは、Drive の代わりに IndexedDB を使う（タブを閉じるまで有効）
  const LOCAL_MODE_KEY = "futari-album:local-mode";
  function readLocalMode() {
    try { return sessionStorage.getItem(LOCAL_MODE_KEY) === "1"; } catch (e) { return false; }
  }
  const localMode = CONFIG.storage.backend === "gdrive" && readLocalMode();
  const storageConfig = localMode
    ? Object.assign({}, CONFIG, { storage: Object.assign({}, CONFIG.storage, { backend: "indexeddb" }) })
    : CONFIG;
  const storage = window.AlbumStorage.createStorage(storageConfig);
  /** サインインが必要なアダプタ（Google Drive）かどうか */
  const hasAuth = typeof storage.signIn === "function";

  const $ = (sel) => document.querySelector(sel);
  const els = {
    album: $("#album"),
    empty: $("#empty"),
    count: $("#count"),
    fileInput: $("#file-input"),
    addBtn: $("#add-btn"),
    exportBtn: $("#export-btn"),
    dropOverlay: $("#drop-overlay"),
    toast: $("#toast"),
    dialog: $("#editor"),
    form: $("#editor-form"),
    heading: $("#editor-heading"),
    progress: $("#editor-progress"),
    preview: $("#editor-preview"),
    title: $("#f-title"),
    comment: $("#f-comment"),
    date: $("#f-date"),
    dateHint: $("#f-date-hint"),
    saveBtn: $("#save-btn"),
    skipBtn: $("#skip-btn"),
    saveAllBtn: $("#save-all-btn"),
    deleteBtn: $("#delete-btn"),
    cancelBtn: $("#cancel-btn"),
    emptyTitle: $("#empty-title"),
    emptyText: $("#empty-text"),
    authBar: $("#auth-bar"),
    authStatus: $("#auth-status"),
    signinBtn: $("#signin-btn"),
    signoutBtn: $("#signout-btn"),
    localModeBtn: $("#local-mode-btn"),
    driveModeBtn: $("#drive-mode-btn"),
  };
  const EMPTY_DEFAULT = { title: els.emptyTitle.textContent, text: els.emptyText.textContent };

  /** @type {Item[]} */
  let items = [];
  /** id → objectURL（再描画のたびに作り直さないためのキャッシュ） */
  const urlCache = new Map();
  /** 追加待ちキュー {file, kind, date, dateSource} */
  let queue = [];
  let queueTotal = 0;
  /** 編集中の状態 {mode:"add"|"edit", id?, entry?} */
  let editing = null;
  let previewUrl = null;
  /** true のあいだは Drive 未設定・未サインインなどでアルバムを操作できない */
  let locked = false;

  /* ---------------- 起動 ---------------- */

  async function start() {
    if (hasAuth) {
      await startWithAuth();
    } else {
      // IndexedDB（従来どおり）。ローカル試用モードのときだけ認証バーに案内を出す
      if (localMode) showAuth("local");
      try {
        await storage.init();
        items = await storage.list();
        render();
      } catch (e) {
        console.error(e);
        toast("保存領域を開けませんでした：" + e.message);
      }
    }
    bindEvents();
    if (hasAuth || localMode) bindAuthEvents();
  }

  /* ---------------- Google Drive の認証まわり ---------------- */

  async function startWithAuth() {
    try {
      await storage.init();
    } catch (e) {
      console.error(e);
      setLocked(true, "Google Drive に接続できませんでした", e.message);
      showAuth("error", "Google Drive に接続できませんでした");
      return;
    }
    if (storage.state === "unconfigured") {
      setLocked(true, "Drive 連携は準備中です", "セットアップが終わるまでは、上の「この端末だけで試す」でお試しできます。");
      showAuth("unconfigured");
      return;
    }
    setLocked(true, "読み込み中…", "Google Drive を確認しています。");
    showAuth("busy", "Google Drive を確認しています…");
    await loadFromDrive();
  }

  async function loadFromDrive() {
    try {
      items = await storage.list();
      setLocked(false);
      render();
      showAuth("signedIn");
    } catch (e) {
      console.error(e);
      if (e && e.authRequired) {
        requireSignIn();
      } else {
        setLocked(true, "アルバムを読み込めませんでした", e.message);
        showAuth("signedIn");
      }
    }
  }

  function requireSignIn(message) {
    setLocked(true, "サインインするとアルバムが表示されます", "上の「Google でサインイン」を押してください。");
    showAuth("signedOut", message);
  }

  /**
   * 認証バーの表示を切り替える
   * @param {"unconfigured"|"signedOut"|"signedIn"|"busy"|"error"|"local"} mode
   */
  function showAuth(mode, message) {
    const folder = (CONFIG.storage.gdrive && CONFIG.storage.gdrive.folderName) || "ふたりアルバム";
    const texts = {
      unconfigured: "Drive 連携は準備中です。セットアップ手順は README を見てください",
      signedOut: "Google Drive に保存します。サインインしてください",
      signedIn: `Google Drive のフォルダ「${folder}」に保存しています`,
      busy: "確認しています…",
      error: "Google Drive に接続できませんでした",
      local: "この端末だけで試しています（ブラウザ内に保存。Drive には保存されません）",
    };
    els.authBar.hidden = false;
    els.authStatus.textContent = message || texts[mode] || "";
    els.signinBtn.hidden = mode !== "signedOut";
    els.signoutBtn.hidden = mode !== "signedIn";
    els.localModeBtn.hidden = !(mode === "unconfigured" || mode === "error");
    els.driveModeBtn.hidden = mode !== "local";
  }

  /** 画面を「操作できない」状態にする／戻す */
  function setLocked(on, title, text) {
    locked = on;
    els.addBtn.disabled = on;
    els.exportBtn.disabled = on;
    if (!on) return;
    items = [];
    for (const url of urlCache.values()) URL.revokeObjectURL(url);
    urlCache.clear();
    els.count.textContent = "";
    els.album.textContent = "";
    els.emptyTitle.textContent = title || "";
    els.emptyText.textContent = text || "";
    els.empty.hidden = false;
  }

  /**
   * 保存操作の直前に、トークンが切れていればサインインし直す。
   * ポップアップを開くため、クリック処理の中で await より前に呼ぶこと。
   */
  function ensureAuth() {
    if (!hasAuth || storage.isSignedIn()) return Promise.resolve();
    return storage.signIn().then(() => showAuth("signedIn"));
  }

  function bindAuthEvents() {
    els.signinBtn.addEventListener("click", () => {
      // signIn() はポップアップを開くので、await を挟まずにすぐ呼ぶ
      const p = storage.signIn();
      showAuth("busy", "サインインしています…");
      p.then(loadFromDrive, (e) => {
        console.error(e);
        requireSignIn(e.message);
      });
    });

    els.signoutBtn.addEventListener("click", async () => {
      if (editing) return;
      await storage.signOut();
      requireSignIn("サインアウトしました");
    });

    els.localModeBtn.addEventListener("click", () => {
      try { sessionStorage.setItem(LOCAL_MODE_KEY, "1"); } catch (e) { /* 使えない環境では何もしない */ }
      location.reload();
    });

    els.driveModeBtn.addEventListener("click", () => {
      try { sessionStorage.removeItem(LOCAL_MODE_KEY); } catch (e) { /* 同上 */ }
      location.reload();
    });
  }

  /* ---------------- 描画 ---------------- */

  async function mediaUrl(id) {
    if (urlCache.has(id)) return urlCache.get(id);
    const blob = await storage.getMedia(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urlCache.set(id, url);
    return url;
  }

  function render() {
    els.emptyTitle.textContent = EMPTY_DEFAULT.title;
    els.emptyText.textContent = EMPTY_DEFAULT.text;
    els.count.textContent = items.length ? `${items.length} 枚の思い出` : "";
    els.empty.hidden = items.length > 0;
    els.album.textContent = "";

    let n = 0;
    for (const group of U.groupByMonth(items)) {
      const section = document.createElement("section");
      section.className = "month";
      const h = document.createElement("h2");
      h.className = "month-title";
      h.innerHTML = `<span class="month-label"></span><span class="month-count"></span>`;
      h.querySelector(".month-label").textContent = group.label;
      h.querySelector(".month-count").textContent = `${group.items.length}枚`;
      section.appendChild(h);

      const grid = document.createElement("div");
      grid.className = "grid";
      for (const item of group.items) grid.appendChild(createCard(item, n++));
      section.appendChild(grid);
      els.album.appendChild(section);
    }
  }

  // 一枚ずつ少し傾け、テープの色と位置を変えてアナログ感を出す
  const TILTS = [-2.2, 1.6, -0.8, 2.4, -1.5, 0.9, -2.8, 1.2];
  const TAPES = ["tape-pink", "tape-mint", "tape-yellow", "tape-blue", "tape-stripe"];

  function createCard(item, index) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card";
    card.style.setProperty("--tilt", TILTS[index % TILTS.length] + "deg");
    card.dataset.id = item.id;
    card.setAttribute("aria-label", `${item.title || "無題"}（${U.dayLabel(item.date)}）を編集`);

    const tape = document.createElement("span");
    tape.className = `tape ${TAPES[index % TAPES.length]} ${index % 3 === 1 ? "tape-corner" : ""}`;
    card.appendChild(tape);

    const frame = document.createElement("div");
    frame.className = "photo";
    card.appendChild(frame);

    mediaUrl(item.id).then((url) => {
      if (!url) {
        frame.classList.add("missing");
        frame.textContent = "読み込めませんでした";
        return;
      }
      if (item.kind === "video") {
        const v = document.createElement("video");
        v.src = url + "#t=0.1"; // 先頭フレームをサムネイル代わりに
        v.muted = true;
        v.playsInline = true;
        v.preload = "metadata";
        frame.appendChild(v);
        const badge = document.createElement("span");
        badge.className = "play-badge";
        badge.textContent = "▶";
        frame.appendChild(badge);
      } else {
        const img = document.createElement("img");
        img.src = url;
        img.alt = item.title || "";
        img.loading = "lazy";
        img.decoding = "async";
        frame.appendChild(img);
      }
    }).catch((e) => {
      console.error(e);
      frame.classList.add("missing");
      frame.textContent = "読み込めませんでした";
      if (e && e.authRequired && hasAuth) showAuth("signedOut", e.message);
    });

    const cap = document.createElement("div");
    cap.className = "caption";
    const t = document.createElement("p");
    t.className = "cap-title";
    t.textContent = item.title || "無題";
    const d = document.createElement("p");
    d.className = "cap-date";
    d.textContent = U.dayLabel(item.date);
    cap.append(t);
    if (item.comment) {
      const c = document.createElement("p");
      c.className = "cap-comment";
      c.textContent = item.comment;
      cap.append(c);
    }
    cap.append(d);
    card.appendChild(cap);

    card.addEventListener("click", () => openEdit(item.id));
    return card;
  }

  /* ---------------- 追加フロー ---------------- */

  async function enqueueFiles(fileList) {
    if (editing && editing.mode === "edit") {
      toast("編集を閉じてから追加してください");
      return;
    }
    if (locked) {
      toast(hasAuth ? "先にサインインしてください" : "いまは追加できません");
      return;
    }
    const files = Array.from(fileList);
    const accepted = [];
    let rejected = 0;
    for (const file of files) {
      const kind = U.detectKind(file);
      if (!kind) { rejected++; continue; }
      const { date, source } = await guessDate(file, kind);
      accepted.push({ file, kind, date, dateSource: source });
    }
    if (rejected) toast(`写真・動画以外のファイル ${rejected} 件は追加しませんでした`);
    if (!accepted.length) return;
    queue = queue.concat(accepted);
    queueTotal += accepted.length;
    if (!editing) nextInQueue();
  }

  /** 撮影日の初期値: EXIF → ファイル更新日時 → 今日 */
  async function guessDate(file, kind) {
    if (kind === "photo" && /jpe?g$/i.test(file.type || file.name)) {
      try {
        const head = await file.slice(0, 256 * 1024).arrayBuffer();
        const exif = U.readExifDate(head);
        if (exif) return { date: exif, source: "写真の撮影情報（EXIF）から" };
      } catch (e) { /* 読めなければ次へ */ }
    }
    if (file.lastModified) {
      return { date: U.toYMD(new Date(file.lastModified)), source: "ファイルの更新日時から" };
    }
    return { date: U.toYMD(new Date()), source: "今日の日付" };
  }

  function nextInQueue() {
    const entry = queue.shift();
    if (!entry) {
      editing = null;
      queueTotal = 0;
      return;
    }
    editing = { mode: "add", entry };
    const pos = queueTotal - queue.length;
    els.heading.textContent = "アルバムに貼る";
    els.progress.textContent = queueTotal > 1 ? `${pos} / ${queueTotal}` : "";
    els.title.value = "";
    els.comment.value = "";
    els.date.value = entry.date;
    els.dateHint.textContent = `初期値：${entry.dateSource}`;
    els.skipBtn.hidden = false;
    els.saveAllBtn.hidden = queue.length === 0;
    els.deleteBtn.hidden = true;
    els.cancelBtn.textContent = queue.length ? "残りもやめる" : "やめる";
    showPreview(URL.createObjectURL(entry.file), entry.kind, true);
    openDialog();
    els.title.focus();
  }

  async function saveCurrentAdd(meta) {
    const { entry } = editing;
    const item = await storage.add(
      { title: meta.title, comment: meta.comment, date: meta.date, kind: entry.kind },
      entry.file
    );
    items.push(item);
  }

  async function saveAllRemaining() {
    // 今表示中のものは入力内容で、残りはタイトルなし・初期日付で保存
    await saveCurrentAdd(readForm());
    let n = 1;
    while (queue.length) {
      const e = queue.shift();
      const item = await storage.add({ title: "", comment: "", date: e.date, kind: e.kind }, e.file);
      items.push(item);
      n++;
    }
    toast(`${n} 件を貼りました。あとからカードを押すと編集できます`);
  }

  /* ---------------- 編集フロー ---------------- */

  async function openEdit(id) {
    if (editing) return;
    const item = items.find((x) => x.id === id);
    if (!item) return;
    editing = { mode: "edit", id };
    els.heading.textContent = "思い出を編集";
    els.progress.textContent = "";
    els.title.value = item.title || "";
    els.comment.value = item.comment || "";
    els.date.value = item.date || "";
    els.dateHint.textContent = item.fileName ? `元ファイル：${item.fileName}` : "";
    els.skipBtn.hidden = true;
    els.saveAllBtn.hidden = true;
    els.deleteBtn.hidden = false;
    els.cancelBtn.textContent = "閉じる";
    let url = null;
    try {
      url = await mediaUrl(id);
    } catch (e) {
      console.error(e);
      toast("写真・動画を読み込めませんでした：" + e.message);
    }
    showPreview(url, item.kind, false);
    openDialog();
  }

  /* ---------------- ダイアログ共通 ---------------- */

  function readForm() {
    return {
      title: els.title.value.trim(),
      comment: els.comment.value.trim(),
      date: els.date.value,
    };
  }

  function showPreview(url, kind, owned) {
    clearPreview();
    if (owned) previewUrl = url; // 追加時の一時 URL は閉じるときに破棄
    if (!url) return;
    let node;
    if (kind === "video") {
      node = document.createElement("video");
      node.controls = true;
      node.playsInline = true;
      node.preload = "metadata";
    } else {
      node = document.createElement("img");
      node.alt = "";
    }
    node.src = url;
    els.preview.appendChild(node);
  }

  function clearPreview() {
    els.preview.textContent = "";
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
  }

  function openDialog() {
    if (!els.dialog.open) els.dialog.showModal();
  }

  function closeDialog() {
    clearPreview();
    if (els.dialog.open) els.dialog.close();
  }

  async function withBusy(fn) {
    els.form.classList.add("busy");
    try {
      await fn();
    } catch (e) {
      console.error(e);
      if (e && e.authRequired && hasAuth) {
        showAuth("signedOut", "サインインが必要です");
        toast("サインインが切れていました。もう一度ボタンを押すとサインイン画面が開きます");
        return false;
      }
      const quota = e && e.name === "QuotaExceededError";
      toast(quota ? "ブラウザの保存容量がいっぱいです" : "保存に失敗しました：" + e.message);
      return false;
    } finally {
      els.form.classList.remove("busy");
    }
    return true;
  }

  /* ---------------- イベント ---------------- */

  function bindEvents() {
    els.addBtn.addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", () => {
      enqueueFiles(els.fileInput.files);
      els.fileInput.value = "";
    });

    els.form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!editing) return;
      const meta = readForm();
      if (!U.isValidYMD(meta.date)) {
        els.date.focus();
        toast("日付を入れてください");
        return;
      }
      const authReady = ensureAuth(); // クリック直後に呼ぶ（ポップアップ対策）
      const ok = await withBusy(async () => {
        await authReady;
        if (editing.mode === "add") {
          await saveCurrentAdd(meta);
        } else {
          const updated = await storage.update(editing.id, meta);
          items = items.map((x) => (x.id === updated.id ? updated : x));
        }
      });
      if (!ok) return;
      render();
      if (editing.mode === "add") {
        clearPreview();
        if (queue.length) return nextInQueue();
      }
      editing = null;
      queueTotal = 0;
      closeDialog();
    });

    els.skipBtn.addEventListener("click", () => {
      clearPreview();
      if (queue.length) return nextInQueue();
      editing = null;
      queueTotal = 0;
      closeDialog();
    });

    els.saveAllBtn.addEventListener("click", async () => {
      const meta = readForm();
      if (!U.isValidYMD(meta.date)) {
        els.date.focus();
        toast("日付を入れてください");
        return;
      }
      const authReady = ensureAuth();
      await withBusy(async () => {
        await authReady;
        await saveAllRemaining();
      });
      render();
      editing = null;
      queueTotal = 0;
      closeDialog();
    });

    els.deleteBtn.addEventListener("click", async () => {
      if (!editing || editing.mode !== "edit") return;
      if (!confirm("この写真・動画をアルバムからはがしますか？（元に戻せません）")) return;
      const id = editing.id;
      const authReady = ensureAuth();
      const ok = await withBusy(async () => {
        await authReady;
        await storage.remove(id);
      });
      if (!ok) return;
      items = items.filter((x) => x.id !== id);
      if (urlCache.has(id)) {
        URL.revokeObjectURL(urlCache.get(id));
        urlCache.delete(id);
      }
      editing = null;
      closeDialog();
      render();
    });

    els.cancelBtn.addEventListener("click", () => {
      queue = [];
      queueTotal = 0;
      editing = null;
      closeDialog();
    });

    // Esc で閉じた場合も状態をリセット
    els.dialog.addEventListener("cancel", () => {
      queue = [];
      queueTotal = 0;
      editing = null;
      clearPreview();
    });

    els.exportBtn.addEventListener("click", async () => {
      if (locked) return;
      let data;
      try {
        const authReady = ensureAuth();
        await authReady;
        data = await storage.exportMetadata();
      } catch (e) {
        console.error(e);
        if (e && e.authRequired && hasAuth) showAuth("signedOut", "サインインが必要です");
        toast("書き出せませんでした：" + e.message);
        return;
      }
      const json = JSON.stringify(data, null, 2);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      a.download = `futari-album-metadata-${U.toYMD(new Date())}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    // ドラッグ＆ドロップで追加
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    window.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      els.dropOverlay.hidden = false;
    });
    window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) els.dropOverlay.hidden = true;
    });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      els.dropOverlay.hidden = true;
      enqueueFiles(e.dataTransfer.files);
    });
  }

  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), 3500);
  }

  start();
})();
