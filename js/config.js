/**
 * ふたりアルバム 設定
 *
 * storage.backend:
 *   "gdrive"    … 既定。Google Drive の既存フォルダ「ふたりアルバム」に保存する。
 *   "indexeddb" … ブラウザ内（IndexedDB）に保存する。Drive が使えないときのフォールバック。
 *
 * 秘密情報（API キー・クライアントシークレット・トークン等）はここに書かないこと。
 * OAuth の「ウェブアプリ用クライアント ID」は公開されても問題ない情報なので、ここに記入してよい。
 */
window.ALBUM_CONFIG = {
  appName: "ふたりアルバム",

  storage: {
    backend: "gdrive",

    indexeddb: {
      dbName: "futari-album",
      dbVersion: 1,
    },

    gdrive: {
      // 作成済みの保存先フォルダ（フォルダ名「ふたりアルバム」。このアプリではなく別ツールで作成したもの）
      folderName: "ふたりアルバム",
      folderId: "15Z7Z42_sIklsHElIYJDvZz7LhR_t33Ca",

      // Google Cloud Console で発行した OAuth クライアント ID（ウェブアプリケーション）を貼る。
      // 例: "1234567890-xxxxxxxx.apps.googleusercontent.com"
      // 空のままだと「Drive 連携は準備中」と表示され、Drive にはアクセスしない。
      clientId: "",

      // 認証スコープ（配列のまま編集できる）。
      // フル Drive スコープを既定にしている理由：
      //   保存先フォルダはこのアプリが作成したものではない（別ツールで作成済み）。
      //   "https://www.googleapis.com/auth/drive.file" は「このアプリが作成した／ユーザーがこのアプリで開いた」
      //   ファイルにしかアクセスできないため、既存フォルダの中身を読み書きできない。
      // ただし storage.js の Drive 呼び出しは、必ず上の folderId 配下（とその子ファイル）だけに限定しており、
      // フォルダ外のファイルを列挙・検索・変更することはない。共有設定にも一切触れない。
      scopes: ["https://www.googleapis.com/auth/drive"],

      // メタデータ一覧（Item 配列）を保存する JSON ファイル名（上のフォルダ内に置く）
      metadataFileName: "album-metadata.json",
    },
  },
};
