/**
 * ふたりアルバム 保存アダプタ
 *
 * 画面側（app.js）はこのファイルの「共通インターフェース」だけを使う。
 * 保存先は config.js の storage.backend で切り替える：
 *   "gdrive"    … GoogleDriveAdapter（既定）
 *   "indexeddb" … IndexedDBAdapter（フォールバック）
 *
 * ── 共通インターフェース ─────────────────────────────
 *   init()            : Promise<void>      初期化
 *   list()            : Promise<Item[]>    全メタデータ
 *   add(meta, file)   : Promise<Item>      メタデータ＋メディア実体を保存
 *   update(id, patch) : Promise<Item>      メタデータのみ更新（title/comment/date）
 *   remove(id)        : Promise<void>      メタデータ＋メディア実体を削除
 *   getMedia(id)      : Promise<Blob|null> メディア実体を取得
 *   exportMetadata()  : Promise<Item[]>    JSON 書き出し用
 *
 * ── Item（メタデータ）─────────────────────────────────
 *   {
 *     id:        string   一意 ID
 *     title:     string   タイトル
 *     comment:   string   ひとことコメント
 *     date:      string   撮影日 "YYYY-MM-DD"（月別グルーピングに使う）
 *     kind:      "photo" | "video"
 *     createdAt: string   登録日時 ISO 8601
 *     // 以下は補助情報
 *     fileName:  string   元ファイル名
 *     mimeType:  string
 *     size:      number   バイト数
 *     mediaRef:  string   メディア実体の参照（IndexedDB では id、Drive では fileId）
 *   }
 */
(function () {
  "use strict";

  const EDITABLE_FIELDS = ["title", "comment", "date"];

  function newId() {
    if (window.crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
    });
  }

  /* ================================================================
   * IndexedDB 実装（フォールバック。動作は v0 から変更なし）
   *   ストア "items" … メタデータ（keyPath: id）
   *   ストア "media" … メディア実体 Blob（key: id）
   *   件数上限は設けていない（上限はブラウザの保存容量のみ）
   * ================================================================ */
  class IndexedDBAdapter {
    constructor(options) {
      this.dbName = (options && options.dbName) || "futari-album";
      this.dbVersion = (options && options.dbVersion) || 1;
      this.db = null;
    }

    init() {
      if (!("indexedDB" in window)) {
        return Promise.reject(new Error("このブラウザは IndexedDB に対応していません"));
      }
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(this.dbName, this.dbVersion);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("items")) {
            const s = db.createObjectStore("items", { keyPath: "id" });
            s.createIndex("date", "date");
          }
          if (!db.objectStoreNames.contains("media")) {
            db.createObjectStore("media");
          }
        };
        req.onsuccess = () => {
          this.db = req.result;
          // 容量逼迫時に勝手に消されないよう永続化を要求（拒否されても動作はする）
          if (navigator.storage && navigator.storage.persist) {
            navigator.storage.persist().catch(() => {});
          }
          resolve();
        };
        req.onerror = () => reject(req.error);
      });
    }

    async list() {
      const tx = this.db.transaction("items", "readonly");
      return reqToPromise(tx.objectStore("items").getAll());
    }

    async add(meta, file) {
      const id = meta.id || newId();
      const item = {
        id,
        title: meta.title || "",
        comment: meta.comment || "",
        date: meta.date,
        kind: meta.kind,
        createdAt: meta.createdAt || new Date().toISOString(),
        fileName: (file && file.name) || "",
        mimeType: (file && file.type) || "",
        size: (file && file.size) || 0,
        mediaRef: id,
      };
      const tx = this.db.transaction(["items", "media"], "readwrite");
      tx.objectStore("items").put(item);
      tx.objectStore("media").put(file, id); // File は Blob なのでそのまま保存できる
      await txDone(tx);
      return item;
    }

    async update(id, patch) {
      const tx = this.db.transaction("items", "readwrite");
      const store = tx.objectStore("items");
      const item = await reqToPromise(store.get(id));
      if (!item) throw new Error("見つかりません: " + id);
      for (const k of EDITABLE_FIELDS) {
        if (patch[k] !== undefined) item[k] = patch[k];
      }
      store.put(item);
      await txDone(tx);
      return item;
    }

    async remove(id) {
      const tx = this.db.transaction(["items", "media"], "readwrite");
      tx.objectStore("items").delete(id);
      tx.objectStore("media").delete(id);
      await txDone(tx);
    }

    async getMedia(id) {
      const tx = this.db.transaction("media", "readonly");
      const blob = await reqToPromise(tx.objectStore("media").get(id));
      return blob || null;
    }

    async exportMetadata() {
      return this.list();
    }
  }

  /* ================================================================
   * Google Drive 実装
   *
   *   - 認証: Google Identity Services（GIS）のトークンクライアントでアクセストークンを取得。
   *           トークンはメモリ内だけに保持する（localStorage 等には保存しない）。
   *   - メディア: folderId 配下に multipart アップロード。返ってきた fileId を item.mediaRef に入れる。
   *   - メタデータ: folderId 配下の album-metadata.json に Item[] を JSON で保存。
   *   - 削除: メディアはゴミ箱へ移動（trashed: true）。完全削除はしない。
   *
   * 触る範囲の約束:
   *   - files.list は必ず「'<folderId>' in parents」で絞り込む。フォルダ外を列挙・検索しない。
   *   - 個別ファイルへのアクセスは、このフォルダ内のメタデータファイルと、
   *     メタデータに記録した mediaRef（このアプリがフォルダ内にアップロードしたファイル）だけ。
   *   - 共有設定（permissions）は一切扱わない。
   *
   * 追加メソッド（認証まわり。app.js は signIn の有無で「認証あり」のアダプタと判定する）:
   *   signIn()     : Promise<void>  ユーザー操作（クリック）の中で呼ぶこと
   *   signOut()    : Promise<void>  トークンを無効化（revoke）して破棄
   *   isSignedIn() : boolean
   *   state        : "idle" | "unconfigured" | "ready"
   * ================================================================ */

  const GIS_SRC = "https://accounts.google.com/gsi/client";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const SILENT_TIMEOUT_MS = 10000;

  /** 認証が必要なことを示すエラー（app.js は err.authRequired を見てサインインを促す） */
  function authError(message) {
    const err = new Error(message || "Google へのサインインが必要です");
    err.authRequired = true;
    return err;
  }

  let gisPromise = null;
  /** GIS スクリプトを 1 回だけ動的に読み込む */
  function loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = GIS_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => {
        if (window.google && google.accounts && google.accounts.oauth2) resolve();
        else reject(new Error("Google のサインイン部品を初期化できませんでした"));
      };
      s.onerror = () => {
        gisPromise = null; // 次回やり直せるように
        reject(new Error("Google のサインイン部品を読み込めませんでした（ネットワークを確認してください）"));
      };
      document.head.appendChild(s);
    });
    return gisPromise;
  }

  const EXT_BY_MIME = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "image/heic": ".heic", "image/heif": ".heif", "image/avif": ".avif",
    "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/3gpp": ".3gp",
  };

  /** Drive の検索クエリ文字列用のエスケープ */
  function q(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  class GoogleDriveAdapter {
    constructor(options) {
      this.options = options || {};
      this.folderId = this.options.folderId;
      this.folderName = this.options.folderName;
      this.clientId = (this.options.clientId || "").trim();
      this.scopes = Array.isArray(this.options.scopes) && this.options.scopes.length
        ? this.options.scopes
        : ["https://www.googleapis.com/auth/drive"];
      this.metadataFileName = this.options.metadataFileName || "album-metadata.json";

      this.state = "idle";
      this.tokenClient = null;
      this.token = null;        // { accessToken, expiresAt(ms) } メモリ内のみ
      this._pending = null;     // 進行中のトークン要求 { resolve, reject, timer }

      this.metaFileId = null;   // album-metadata.json の fileId キャッシュ
      this.metaCache = null;    // Item[] のメモリキャッシュ
      this._chain = Promise.resolve(); // メタデータ読み書きの直列化用
    }

    /* ---------- 初期化・認証 ---------- */

    async init() {
      if (!this.clientId) {
        // 例外にはせず「未設定」として扱う（画面側で案内を出す）
        this.state = "unconfigured";
        return;
      }
      if (!this.folderId) throw new Error("保存先フォルダ ID（folderId）が設定されていません");
      await loadGis();
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: this.scopes.join(" "),
        callback: (resp) => this._onToken(resp),
        error_callback: (err) => this._onTokenError(err),
      });
      this.state = "ready";
    }

    _assertConfigured() {
      if (this.state === "unconfigured") throw new Error("Drive 連携が未設定です（config.js の clientId を設定してください）");
      if (this.state !== "ready") throw new Error("Drive 連携がまだ初期化されていません");
    }

    isSignedIn() {
      return !!(this.token && Date.now() < this.token.expiresAt);
    }

    /** ボタンのクリック処理の中から（await を挟まずに）呼ぶこと。ポップアップがブロックされるため */
    signIn() {
      try { this._assertConfigured(); } catch (e) { return Promise.reject(e); }
      // prompt は指定しない（初回は同意画面、以降は必要に応じてアカウント選択が出る）
      return this._requestToken({}, 0);
    }

    async signOut() {
      const t = this.token;
      this._clearToken();
      this.metaCache = null;
      this.metaFileId = null;
      if (t && window.google && google.accounts && google.accounts.oauth2) {
        await new Promise((resolve) => {
          try { google.accounts.oauth2.revoke(t.accessToken, () => resolve()); }
          catch (e) { resolve(); }
        });
      }
    }

    _clearToken() {
      this.token = null;
    }

    /**
     * トークンを要求する。timeoutMs > 0 のときはその時間で諦める（サイレント取得用）。
     * GIS のコールバックは 1 つなので、同時に複数の要求は持たない（古い要求は失敗扱いにする）。
     */
    _requestToken(overrides, timeoutMs) {
      if (this._pending) {
        clearTimeout(this._pending.timer);
        this._pending.reject(authError());
        this._pending = null;
      }
      return new Promise((resolve, reject) => {
        const pending = { resolve, reject, timer: null };
        if (timeoutMs > 0) {
          pending.timer = setTimeout(() => {
            if (this._pending === pending) this._pending = null;
            reject(authError());
          }, timeoutMs);
        }
        this._pending = pending;
        try {
          this.tokenClient.requestAccessToken(overrides || {});
        } catch (e) {
          clearTimeout(pending.timer);
          this._pending = null;
          reject(authError("サインインを開始できませんでした：" + e.message));
        }
      });
    }

    _settle(ok, value) {
      const p = this._pending;
      if (!p) return;
      this._pending = null;
      clearTimeout(p.timer);
      ok ? p.resolve(value) : p.reject(value);
    }

    _onToken(resp) {
      if (!resp || resp.error || !resp.access_token) {
        this._settle(false, authError("サインインできませんでした" + (resp && resp.error ? `（${resp.error}）` : "")));
        return;
      }
      // 画面で Drive へのアクセスのチェックを外された場合など
      const granted = google.accounts.oauth2.hasGrantedAllScopes
        ? google.accounts.oauth2.hasGrantedAllScopes(resp, ...this.scopes)
        : true;
      if (!granted) {
        this._settle(false, authError("Google Drive へのアクセスが許可されませんでした。サインイン時に Drive へのアクセスを許可してください"));
        return;
      }
      const sec = Number(resp.expires_in) || 3600;
      // 期限ぎりぎりで失敗しないよう 60 秒早めに期限切れとみなす
      this.token = { accessToken: resp.access_token, expiresAt: Date.now() + Math.max(0, sec - 60) * 1000 };
      this._settle(true);
    }

    _onTokenError(err) {
      // popup_closed / popup_failed_to_open など
      const type = err && err.type ? `（${err.type}）` : "";
      this._settle(false, authError("サインインが完了しませんでした" + type));
    }

    /** 有効なトークンがなければ例外。silent=true ならまずサイレント取得を試す */
    async _ensureToken(silent) {
      this._assertConfigured();
      if (this.isSignedIn()) return;
      this._clearToken();
      if (!silent) throw authError("サインインの有効期限が切れました。もう一度サインインしてください");
      await this._requestToken({ prompt: "" }, SILENT_TIMEOUT_MS);
      if (!this.isSignedIn()) throw authError();
    }

    /* ---------- Drive API 呼び出し（fetch） ---------- */

    /**
     * @param {string} method
     * @param {string} url       完全 URL
     * @param {object} [opt]     { query, body, headers, as: "json"|"blob"|"none", allow404 }
     */
    async _fetch(method, url, opt) {
      opt = opt || {};
      if (!this.isSignedIn()) {
        this._clearToken();
        throw authError("サインインの有効期限が切れました。もう一度サインインしてください");
      }
      const u = new URL(url);
      u.searchParams.set("supportsAllDrives", "true");
      for (const [k, v] of Object.entries(opt.query || {})) u.searchParams.set(k, v);

      const headers = Object.assign({ Authorization: "Bearer " + this.token.accessToken }, opt.headers || {});
      let res;
      try {
        res = await fetch(u.toString(), { method, headers, body: opt.body });
      } catch (e) {
        throw new Error("Google Drive に接続できませんでした（ネットワークを確認してください）");
      }
      if (res.status === 401) {
        this._clearToken();
        throw authError("サインインの有効期限が切れました。もう一度サインインしてください");
      }
      if (res.status === 404 && opt.allow404) return null;
      if (!res.ok) {
        let detail = "";
        try {
          const j = await res.json();
          detail = (j && j.error && j.error.message) || "";
        } catch (e) { /* 本文なし */ }
        const err = new Error(`Google Drive の操作に失敗しました（HTTP ${res.status}）${detail ? "：" + detail : ""}`);
        err.status = res.status;
        throw err;
      }
      if (opt.as === "blob") return res.blob();
      if (opt.as === "none") return true;
      return res.json();
    }

    /** multipart/related の本文を作る（メタデータ JSON ＋ 中身） */
    _multipart(metadata, content, contentType) {
      const boundary = "futari-album-" + newId();
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        JSON.stringify(metadata),
        `\r\n--${boundary}\r\nContent-Type: ${contentType || "application/octet-stream"}\r\n\r\n`,
        content,
        `\r\n--${boundary}--`,
      ]);
      return { body, contentType: `multipart/related; boundary=${boundary}` };
    }

    /** フォルダ直下に新規ファイルを作る。返り値は fileId */
    async _createFile(name, content, contentType) {
      const mp = this._multipart({ name, parents: [this.folderId] }, content, contentType);
      const res = await this._fetch("POST", `${DRIVE_UPLOAD}/files`, {
        query: { uploadType: "multipart", fields: "id" },
        headers: { "Content-Type": mp.contentType },
        body: mp.body,
      });
      return res.id;
    }

    /** ゴミ箱へ移動（完全削除はしない）。対象がこのフォルダ内にあることを確認してから行う */
    async _trash(fileId) {
      const meta = await this._fetch("GET", `${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
        query: { fields: "id,parents,trashed" },
        allow404: true,
      });
      if (!meta || meta.trashed) return; // もう無い・既にゴミ箱
      if (!Array.isArray(meta.parents) || !meta.parents.includes(this.folderId)) {
        // フォルダ外へ移動されたファイルには触らない（アルバムの記録からだけ外す）
        console.warn("アルバムのフォルダ外のファイルのため、ゴミ箱へ移動しませんでした:", fileId);
        return;
      }
      await this._fetch("PATCH", `${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
        query: { fields: "id" },
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ trashed: true }),
      });
    }

    /* ---------- メタデータ（album-metadata.json） ---------- */

    /** メタデータの読み書きを直列化する（同時に保存して上書きし合わないように） */
    _serial(fn) {
      const run = this._chain.then(() => fn());
      this._chain = run.catch(() => {});
      return run;
    }

    async _findMetaFile() {
      const res = await this._fetch("GET", `${DRIVE_API}/files`, {
        query: {
          q: `name='${q(this.metadataFileName)}' and '${q(this.folderId)}' in parents and trashed=false`,
          fields: "files(id,name,modifiedTime)",
          orderBy: "createdTime",
          pageSize: "10",
          spaces: "drive",
          includeItemsFromAllDrives: "true",
        },
      });
      const files = (res && res.files) || [];
      return files.length ? files[0].id : null;
    }

    /** Drive から読み直してキャッシュを更新する（_serial の中で呼ぶ） */
    async _loadMeta() {
      const fileId = await this._findMetaFile();
      this.metaFileId = fileId;
      if (!fileId) {
        this.metaCache = [];
        return this.metaCache;
      }
      const blob = await this._fetch("GET", `${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
        query: { alt: "media" },
        as: "blob",
      });
      const text = await blob.text();
      let data;
      try {
        data = text.trim() ? JSON.parse(text) : [];
      } catch (e) {
        // 壊れたファイルを空配列で上書きしてしまわないよう、ここで止める
        throw new Error(`${this.metadataFileName} を読み取れませんでした（JSON の形式が正しくありません）`);
      }
      if (!Array.isArray(data)) {
        throw new Error(`${this.metadataFileName} の形式が想定と違います（配列ではありません）`);
      }
      this.metaCache = data;
      return this.metaCache;
    }

    /** キャッシュ中の配列を Drive に保存する（_serial の中で呼ぶ） */
    async _saveMeta(items) {
      const json = JSON.stringify(items, null, 2);
      const type = "application/json; charset=UTF-8";
      if (this.metaFileId) {
        const ok = await this._fetch("PATCH", `${DRIVE_UPLOAD}/files/${encodeURIComponent(this.metaFileId)}`, {
          query: { uploadType: "media", fields: "id" },
          headers: { "Content-Type": type },
          body: json,
          allow404: true,
        });
        if (ok) {
          this.metaCache = items;
          return;
        }
        this.metaFileId = null; // 消されていた → 作り直す
      }
      this.metaFileId = await this._createFile(this.metadataFileName, new Blob([json], { type }), type);
      this.metaCache = items;
    }

    /* ---------- 共通インターフェース ---------- */

    async list() {
      await this._ensureToken(true);
      const items = await this._serial(() => this._loadMeta());
      return items.slice();
    }

    async add(meta, file) {
      await this._ensureToken(false);
      const id = meta.id || newId();
      const mimeType = (file && file.type) || "";
      const name = (file && file.name) || id + (EXT_BY_MIME[mimeType.toLowerCase()] || "");

      // 1) メディアをフォルダにアップロード
      const fileId = await this._createFile(name, file, mimeType || "application/octet-stream");

      const item = {
        id,
        title: meta.title || "",
        comment: meta.comment || "",
        date: meta.date,
        kind: meta.kind,
        createdAt: meta.createdAt || new Date().toISOString(),
        fileName: (file && file.name) || name,
        mimeType,
        size: (file && file.size) || 0,
        mediaRef: fileId,
      };

      // 2) メタデータに追加して保存（最新を読み直してから追記する）
      try {
        await this._serial(async () => {
          const items = (await this._loadMeta()).slice();
          items.push(item);
          await this._saveMeta(items);
        });
      } catch (e) {
        // メタデータに載らなかったメディアは孤立するので、ゴミ箱へ戻しておく（失敗しても無視）
        this._trash(fileId).catch(() => {});
        throw e;
      }
      return item;
    }

    async update(id, patch) {
      await this._ensureToken(false);
      return this._serial(async () => {
        const items = (await this._loadMeta()).slice();
        const idx = items.findIndex((x) => x.id === id);
        if (idx < 0) throw new Error("見つかりません: " + id);
        const item = Object.assign({}, items[idx]);
        for (const k of EDITABLE_FIELDS) {
          if (patch[k] !== undefined) item[k] = patch[k];
        }
        items[idx] = item;
        await this._saveMeta(items);
        return item;
      });
    }

    async remove(id) {
      await this._ensureToken(false);
      await this._serial(async () => {
        const items = await this._loadMeta();
        const target = items.find((x) => x.id === id);
        if (!target) return; // すでに無い
        if (target.mediaRef) await this._trash(target.mediaRef);
        await this._saveMeta(items.filter((x) => x.id !== id));
      });
    }

    async getMedia(id) {
      if (!this.metaCache) await this.list();
      else await this._ensureToken(false);
      const item = (this.metaCache || []).find((x) => x.id === id);
      if (!item || !item.mediaRef) return null;
      const blob = await this._fetch("GET", `${DRIVE_API}/files/${encodeURIComponent(item.mediaRef)}`, {
        query: { alt: "media" },
        as: "blob",
        allow404: true,
      });
      if (!blob) return null;
      // Content-Type が付かなかった場合に備えて、記録している MIME を付け直す
      if (!blob.type && item.mimeType) return new Blob([blob], { type: item.mimeType });
      return blob;
    }

    async exportMetadata() {
      return this.list();
    }
  }

  function createStorage(config) {
    const s = (config && config.storage) || {};
    switch (s.backend) {
      case "gdrive":
        return new GoogleDriveAdapter(s.gdrive);
      case "indexeddb":
      default:
        return new IndexedDBAdapter(s.indexeddb);
    }
  }

  window.AlbumStorage = { createStorage, IndexedDBAdapter, GoogleDriveAdapter, newId };
})();
