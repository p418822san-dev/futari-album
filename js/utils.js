/**
 * ふたりアルバム 純粋関数ユーティリティ（DOM 非依存。Node でもテスト可能）
 *   - EXIF の撮影日時読み取り（JPEG の DateTimeOriginal / DateTime）
 *   - 日付フォーマット、月別グルーピング
 */
(function (root) {
  "use strict";

  /** Date → "YYYY-MM-DD"（ローカル時刻） */
  function toYMD(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function isValidYMD(s) {
    return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  }

  /** "YYYY-MM-DD" → "YYYY-MM" */
  function monthKey(ymd) {
    return isValidYMD(ymd) ? ymd.slice(0, 7) : "unknown";
  }

  /** "YYYY-MM" → "2026年11月" */
  function monthLabel(key) {
    if (key === "unknown") return "日付なし";
    const [y, m] = key.split("-");
    return `${Number(y)}年${Number(m)}月`;
  }

  /** "YYYY-MM-DD" → "11月4日" */
  function dayLabel(ymd) {
    if (!isValidYMD(ymd)) return "";
    const [, m, d] = ymd.split("-");
    return `${Number(m)}月${Number(d)}日`;
  }

  /**
   * Item[] を月別にまとめる。新しい月が上、月内も新しい日付が上。
   * 同じ日付なら登録が新しいものを上にする。
   * @returns {{key:string,label:string,items:Item[]}[]}
   */
  function groupByMonth(items) {
    const sorted = items.slice().sort((a, b) => {
      const da = a.date || "", db = b.date || "";
      if (da !== db) return da < db ? 1 : -1;
      const ca = a.createdAt || "", cb = b.createdAt || "";
      return ca < cb ? 1 : ca > cb ? -1 : 0;
    });
    const groups = [];
    const map = new Map();
    for (const it of sorted) {
      const key = monthKey(it.date);
      let g = map.get(key);
      if (!g) {
        g = { key, label: monthLabel(key), items: [] };
        map.set(key, g);
        groups.push(g);
      }
      g.items.push(it);
    }
    // "日付なし" は最後に
    groups.sort((a, b) => (a.key === "unknown") - (b.key === "unknown"));
    return groups;
  }

  /** MIME / 拡張子から "photo" | "video" | null */
  function detectKind(file) {
    const type = (file.type || "").toLowerCase();
    if (type.startsWith("image/")) return "photo";
    if (type.startsWith("video/")) return "video";
    const name = (file.name || "").toLowerCase();
    if (/\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/.test(name)) return "photo";
    if (/\.(mp4|mov|m4v|webm|ogv|3gp)$/.test(name)) return "video";
    return null;
  }

  /**
   * JPEG の ArrayBuffer から EXIF 撮影日時を読む。
   * DateTimeOriginal(0x9003) → DateTimeDigitized(0x9004) → DateTime(0x0132) の順で採用。
   * @returns {string|null} "YYYY-MM-DD" または null
   */
  function readExifDate(buffer) {
    try {
      const view = new DataView(buffer);
      if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // JPEG でない
      let offset = 2;
      while (offset + 4 <= view.byteLength) {
        const marker = view.getUint16(offset);
        if ((marker & 0xff00) !== 0xff00) return null;
        const size = view.getUint16(offset + 2);
        if (marker === 0xffe1) {
          const start = offset + 4;
          // "Exif\0\0"
          if (
            start + 6 <= view.byteLength &&
            view.getUint32(start) === 0x45786966 &&
            view.getUint16(start + 4) === 0x0000
          ) {
            return parseTiff(view, start + 6);
          }
        }
        if (marker === 0xffda) return null; // 画像データ開始。以降に EXIF はない
        offset += 2 + size;
      }
    } catch (e) {
      /* 壊れた EXIF は無視して null */
    }
    return null;
  }

  function parseTiff(view, tiff) {
    const order = view.getUint16(tiff);
    const le = order === 0x4949; // "II"
    if (!le && order !== 0x4d4d) return null;
    const u16 = (o) => view.getUint16(o, le);
    const u32 = (o) => view.getUint32(o, le);
    if (u16(tiff + 2) !== 0x002a) return null;

    function readIfd(ifdOffset) {
      const entries = {};
      const base = tiff + ifdOffset;
      if (base + 2 > view.byteLength) return entries;
      const count = u16(base);
      for (let i = 0; i < count; i++) {
        const e = base + 2 + i * 12;
        if (e + 12 > view.byteLength) break;
        entries[u16(e)] = { type: u16(e + 2), count: u32(e + 4), valueAt: e + 8 };
      }
      return entries;
    }

    function readAscii(entry) {
      if (!entry || entry.type !== 2) return null;
      const at = entry.count > 4 ? tiff + u32(entry.valueAt) : entry.valueAt;
      let s = "";
      for (let i = 0; i < entry.count && at + i < view.byteLength; i++) {
        const c = view.getUint8(at + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    }

    const ifd0 = readIfd(u32(tiff + 4));
    let candidates = [];
    if (ifd0[0x8769]) {
      const exif = readIfd(u32(ifd0[0x8769].valueAt));
      candidates.push(readAscii(exif[0x9003]), readAscii(exif[0x9004]));
    }
    candidates.push(readAscii(ifd0[0x0132]));
    for (const c of candidates) {
      const m = c && c.match(/^(\d{4}):(\d{2}):(\d{2})/);
      if (m && m[1] !== "0000") return `${m[1]}-${m[2]}-${m[3]}`;
    }
    return null;
  }

  const api = { toYMD, isValidYMD, monthKey, monthLabel, dayLabel, groupByMonth, detectKind, readExifDate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AlbumUtils = api;
})(typeof window !== "undefined" ? window : globalThis);
