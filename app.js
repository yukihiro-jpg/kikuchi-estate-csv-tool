"use strict";

// ===== 保存（localStorage） =====
const STORAGE_KEY = "kikuchi_csv_tool_v1";

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, accounts: [], selectedAccountId: null };
    const obj = JSON.parse(raw);
    if (!obj.accounts) obj.accounts = [];
    return obj;
  } catch (e) {
    return { version: 1, accounts: [], selectedAccountId: null };
  }
}
function saveStore() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

let store = loadStore();
let lastImport = null; // 直近に取り込んだ生データ {columns, dataRows, hasHeader}
let formMode = "edit"; // "edit" | "new"

// マッピングで扱う役割（色つき）
const ROLES = [
  { key: "date", label: "日付", required: true, color: "#0071e3", tint: "#e7f1fd" },
  { key: "withdrawal", label: "出金額", color: "#d70015", tint: "#fdecec" },
  { key: "deposit", label: "入金額", color: "#1d7d3f", tint: "#e7f8ed" },
  { key: "amount", label: "入出金（1列）", color: "#8944ab", tint: "#f3e9f8" },
  { key: "balance", label: "残高", color: "#b25000", tint: "#fcefe3" },
  { key: "description", label: "摘要", color: "#0a7e8c", tint: "#e3f4f6", multi: true },
];
const GUESS = {
  date: ["日付", "年月日", "取引日", "お取引日"],
  withdrawal: ["出金", "お引出", "引出", "お支払", "支払", "引落", "出金金額"],
  deposit: ["入金", "お預入", "預入", "預り", "入金金額"],
  amount: ["入出金", "取引金額", "金額"],
  balance: ["残高", "残額"],
  description: ["摘要", "お取引内容", "取引内容", "内容", "明細", "備考", "メモ"],
};

// 入出金の分類項目（store.categories に保存・設定で編集可能）
const DEFAULT_CATEGORIES = {
  入金: ["家賃", "ガス代", "預り敷金", "クリーニング代", "その他"],
  出金: ["預り敷金の返済", "家賃の返金", "ガス代の返金", "その他"],
};
function ensureCategories() {
  if (!store.categories) store.categories = {};
  if (!Array.isArray(store.categories["入金"])) store.categories["入金"] = DEFAULT_CATEGORIES["入金"].slice();
  if (!Array.isArray(store.categories["出金"])) store.categories["出金"] = DEFAULT_CATEGORIES["出金"].slice();
}
function categoryOptions(dir) {
  ensureCategories();
  if (store.categories[dir]) return store.categories[dir];
  return Array.from(new Set([...store.categories["入金"], ...store.categories["出金"]]));
}
// 既存データから空行（マッピング列がすべて空の行）を除去
function cleanupBlankTransactions() {
  let removed = 0;
  store.accounts.forEach((a) => {
    if (!a.mapping || !Array.isArray(a.transactions)) return;
    const roles = a.mapping.roles;
    const before = a.transactions.length;
    a.transactions = a.transactions.filter((t) => isMeaningfulRow(roles, t.cells));
    removed += before - a.transactions.length;
  });
  if (removed > 0) saveStore();
}

function categoriesForTx(dir, tx) {
  const base = categoryOptions(dir).slice();
  (tx.items || []).forEach((it) => {
    if (it.category && (it.cdir || dir) === dir && !base.includes(it.category)) base.push(it.category);
  });
  return base;
}

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const accountTabs = $("account-tabs");
const settingsBtn = $("settings-btn");
const balanceAlert = $("balance-alert");

const accountSection = $("account-section");
const accountHeading = $("account-heading");
const bankNameInput = $("bank-name");
const accountNumberInput = $("account-number");
const accountSave = $("account-save");
const accountCancel = $("account-cancel");
const accountDelete = $("account-delete");
const accountStatus = $("account-status");

const importSection = $("import-section");
const dropzone = $("dropzone");
const fileInput = $("file-input");
const fileStatus = $("file-status");
const pasteArea = $("paste-area");
const pasteBtn = $("paste-btn");
const hasHeader = $("has-header");
const remapBtn = $("remap-btn");

const mappingSection = $("mapping-section");
const mappingFields = $("mapping-fields");
const mappingApply = $("mapping-apply");
const mappingCancel = $("mapping-cancel");
const mappingStatus = $("mapping-status");

const editSection = $("edit-section");
const tableHead = document.querySelector("#data-table thead");
const tableBody = document.querySelector("#data-table tbody");
const rowSummary = $("row-summary");
const editSave = $("edit-save");
const editStatus = $("edit-status");

const finalSection = $("final-section");
const finalTableHead = document.querySelector("#final-table thead");
const finalTableBody = document.querySelector("#final-table tbody");
const finalSummary = $("final-summary");

const settingsDrawer = $("settings-drawer");
const settingsOverlay = $("settings-overlay");
const settingsClose = $("settings-close");
const categoryManager = $("category-manager");
const allPeriod = $("all-period");
const rangeSelectors = $("range-selectors");
const fromYear = $("from-year");
const fromMonth = $("from-month");
const toYear = $("to-year");
const toMonth = $("to-month");
const bulkDownloadBtn = $("bulk-download-btn");
const exportStatus = $("export-status");
const backupBtn = $("backup-btn");
const restoreInput = $("restore-input");
const backupStatus = $("backup-status");

// ===== ユーティリティ =====
function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}
function getCurrentAccount() {
  return store.accounts.find((a) => a.id === store.selectedAccountId) || null;
}
function yen(n) {
  return "¥" + Number(n || 0).toLocaleString("ja-JP");
}
// 入力欄用：数字だけ取り出して #,### に整形（マイナス可）
function formatAmountInput(s) {
  const str = String(s == null ? "" : s);
  const neg = /^\s*[-−]/.test(str);
  const digits = str.replace(/[^\d]/g, "");
  if (digits === "") return "";
  return (neg ? "-" : "") + parseInt(digits, 10).toLocaleString("ja-JP");
}

// 金額の文字列を数値へ（△▲・カッコ・＋−・カンマ・¥等に対応）
function toNumber(str) {
  if (str == null) return 0;
  let s = String(str).replace(/[,\s　¥￥円]/g, "");
  let neg = false;
  if (/^[△▲]/.test(s) || /^\(.*\)$/.test(s)) { neg = true; s = s.replace(/[△▲()（）]/g, ""); }
  if (/^-/.test(s)) neg = true;
  s = s.replace(/^[+\-]/, "");
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  return neg ? -n : n;
}

// 役割＋行データから 区分/金額/摘要 を取り出す
function dirOf(roles, cells) {
  if (roles.deposit != null && Math.abs(toNumber(cells[roles.deposit])) > 0) return "入金";
  if (roles.withdrawal != null && Math.abs(toNumber(cells[roles.withdrawal])) > 0) return "出金";
  if (roles.amount != null) {
    const v = toNumber(cells[roles.amount]);
    if (v > 0) return "入金";
    if (v < 0) return "出金";
  }
  return "";
}
function amtOf(roles, cells) {
  if (roles.deposit != null) { const v = Math.abs(toNumber(cells[roles.deposit])); if (v) return v; }
  if (roles.withdrawal != null) { const v = Math.abs(toNumber(cells[roles.withdrawal])); if (v) return v; }
  if (roles.amount != null) return Math.abs(toNumber(cells[roles.amount]));
  return 0;
}
function descCols(roles) {
  const d = roles.description;
  if (d == null) return [];
  return Array.isArray(d) ? d : [d];
}
function descOf(roles, cells) {
  return descCols(roles)
    .map((i) => String(cells[i] || "").trim())
    .filter((s) => s !== "")
    .join(" ");
}
// 取引として意味のある行か（マッピング列がすべて空の行＝銀行ファイルの見出し/口座情報行などを除外）
function isMeaningfulRow(roles, cells) {
  const dateOk = roles.date != null && String(cells[roles.date] == null ? "" : cells[roles.date]).trim() !== "";
  const descOk = descOf(roles, cells).trim() !== "";
  const balOk = roles.balance != null && String(cells[roles.balance] == null ? "" : cells[roles.balance]).trim() !== "";
  return dateOk || descOk || balOk || amtOf(roles, cells) !== 0;
}

// 残高チェック用：入金（＋）・出金（−）の符号付き増減
function signedAmt(roles, cells) {
  let s = 0;
  if (roles.deposit != null) s += Math.abs(toNumber(cells[roles.deposit]));
  if (roles.withdrawal != null) s -= Math.abs(toNumber(cells[roles.withdrawal]));
  if (s === 0 && roles.amount != null) s = toNumber(cells[roles.amount]);
  return s;
}
function parseDateNum(s) {
  const m = String(s || "").match(/(\d{4})\s*[\/\-\.年]\s*(\d{1,2})\s*[\/\-\.月]\s*(\d{1,2})/);
  if (!m) return null;
  return +m[1] * 10000 + +m[2] * 100 + +m[3];
}
function formatDateJP(s) {
  const m = String(s || "").match(/(\d{4})\s*[\/\-\.年]\s*(\d{1,2})\s*[\/\-\.月]\s*(\d{1,2})/);
  if (!m) return String(s || "");
  return `${+m[2]}月${+m[3]}日`;
}
// 残高が連続しているかを確認（アップロード漏れの検出）
function checkBalanceContinuity(acc) {
  if (!acc.mapping) return { ok: true, gaps: [] };
  const roles = acc.mapping.roles;
  if (roles.balance == null) return { ok: true, gaps: [] };
  const hasAmt = roles.deposit != null || roles.withdrawal != null || roles.amount != null;
  if (!hasAmt) return { ok: true, gaps: [] };
  const arr = [];
  for (let i = 0; i < acc.transactions.length; i++) {
    const t = acc.transactions[i];
    const d = parseDateNum(roles.date != null ? t.cells[roles.date] : "");
    if (d == null) return { ok: true, gaps: [] }; // 日付が読めない場合はチェックしない
    arr.push({
      i,
      d,
      bal: toNumber(t.cells[roles.balance]),
      delta: signedAmt(roles, t.cells),
      dateStr: formatDateJP(roles.date != null ? t.cells[roles.date] : ""),
    });
  }
  if (arr.length < 2) return { ok: true, gaps: [] };
  arr.sort((a, b) => a.d - b.d || a.i - b.i);
  const gaps = [];
  for (let k = 1; k < arr.length; k++) {
    const expected = arr[k - 1].bal + arr[k].delta;
    if (Math.round(expected) !== Math.round(arr[k].bal)) {
      gaps.push({ from: arr[k - 1].dateStr, to: arr[k].dateStr });
    }
  }
  return { ok: gaps.length === 0, gaps };
}

// 明細テーブルに表示する列（マッピング済みのものだけ・役割名で見出し）
const DISPLAY_COLS = [
  { key: "date", label: "日付" },
  { key: "description", label: "摘要" },
  { key: "deposit", label: "入金", num: true },
  { key: "withdrawal", label: "出金", num: true },
  { key: "amount", label: "入出金", num: true },
  { key: "balance", label: "残高", num: true },
];
function displayColumns(roles) {
  return DISPLAY_COLS.filter((c) =>
    c.key === "description" ? descCols(roles).length > 0 : roles[c.key] != null
  );
}
function displayValue(roles, cells, col) {
  if (col.key === "description") return descOf(roles, cells);
  const idx = roles[col.key];
  if (idx == null) return "";
  const raw = cells[idx];
  if (raw == null || String(raw).trim() === "") return "";
  if (col.num) return toNumber(raw).toLocaleString("ja-JP");
  return String(raw);
}
// 上段（通帳データ行）の列：摘要の直後に「物件名」列を差し込む
function topColumns(roles) {
  const arr = displayColumns(roles);
  let idx = arr.findIndex((c) => c.key === "description");
  if (idx < 0) idx = arr.findIndex((c) => c.key === "date");
  arr.splice(idx + 1, 0, { key: "__property", label: "物件名" });
  return arr;
}

// ===== 学習（摘要×区分 ごとの内訳） =====
function learnKey(dir, desc) {
  return dir + "" + normKey(desc);
}
function getLearned(acc, dir, desc) {
  if (!acc.learn) return null;
  const d = String(desc || "").trim();
  if (!d || !dir) return null;
  return acc.learn[learnKey(dir, desc)] || null;
}
function setLearned(acc, dir, desc, entity, property, items) {
  const d = String(desc || "").trim();
  if (!d || !dir) return;
  if (!acc.learn) acc.learn = {};
  acc.learn[learnKey(dir, desc)] = {
    entity: entity || "",
    property: property || "",
    items: items.map((it) => ({ category: it.category, amount: it.amount, cdir: it.cdir || dir })),
  };
}

// ===== 口座タブ =====
function renderTabs() {
  accountTabs.innerHTML = "";
  store.accounts.forEach((a) => {
    const b = document.createElement("button");
    const hasGap = a.mapping && !checkBalanceContinuity(a).ok;
    b.className = "acc-tab" + (a.id === store.selectedAccountId && formMode !== "new" ? " active" : "") + (hasGap ? " has-error" : "");
    const label = (a.bankName + (a.accountNumber ? "　" + a.accountNumber : "")).trim() || "(無名の口座)";
    b.textContent = label;
    if (hasGap) {
      const warn = document.createElement("span");
      warn.className = "tab-warn";
      warn.textContent = "⚠";
      warn.title = "残高がつながっていません";
      b.appendChild(warn);
    }
    b.title = label;
    b.addEventListener("click", () => {
      store.selectedAccountId = a.id;
      formMode = "edit";
      lastImport = null;
      saveStore();
      setStatus(accountStatus, "", "");
      setStatus(fileStatus, "", "");
      renderAll();
    });
    accountTabs.appendChild(b);
  });
  const add = document.createElement("button");
  add.className = "acc-tab add" + (formMode === "new" ? " active" : "");
  add.textContent = "＋ 口座を追加";
  add.addEventListener("click", () => {
    formMode = "new";
    setStatus(accountStatus, "", "");
    renderAll();
    bankNameInput.focus();
  });
  accountTabs.appendChild(add);
}

// ===== 口座情報セクション =====
function renderAccountSection() {
  const acc = getCurrentAccount();
  if (formMode === "new" || !acc) {
    accountHeading.textContent = "新しい口座を登録";
    bankNameInput.value = "";
    accountNumberInput.value = "";
    accountSave.textContent = "登録";
    accountCancel.classList.toggle("hidden", store.accounts.length === 0);
    accountDelete.classList.add("hidden");
  } else {
    accountHeading.textContent = "口座情報";
    bankNameInput.value = acc.bankName;
    accountNumberInput.value = acc.accountNumber;
    accountSave.textContent = "保存";
    accountCancel.classList.add("hidden");
    accountDelete.classList.remove("hidden");
  }
}

function saveAccount() {
  const bankName = bankNameInput.value.trim();
  const accountNumber = accountNumberInput.value.trim();
  if (!bankName) {
    setStatus(accountStatus, "銀行名を入力してください", "error");
    return;
  }
  if (formMode === "new") {
    const id = "acc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    store.accounts.push({ id, bankName, accountNumber, mapping: null, transactions: [], learn: {} });
    store.selectedAccountId = id;
    formMode = "edit";
    setStatus(accountStatus, `口座「${bankName}」を登録しました`, "ok");
  } else {
    const acc = getCurrentAccount();
    if (acc) { acc.bankName = bankName; acc.accountNumber = accountNumber; }
    setStatus(accountStatus, "口座情報を更新しました", "ok");
  }
  saveStore();
  renderAll();
}

function cancelAccountForm() {
  formMode = "edit";
  if (!getCurrentAccount() && store.accounts.length) {
    store.selectedAccountId = store.accounts[0].id;
  }
  setStatus(accountStatus, "", "");
  renderAll();
}

function deleteAccount() {
  const acc = getCurrentAccount();
  if (!acc) return;
  const ok = confirm(
    `口座「${acc.bankName} ${acc.accountNumber}」と、その保存済み明細（${acc.transactions.length}件）をすべて削除します。よろしいですか？`
  );
  if (!ok) return;
  store.accounts = store.accounts.filter((a) => a.id !== acc.id);
  store.selectedAccountId = store.accounts.length ? store.accounts[0].id : null;
  formMode = store.accounts.length ? "edit" : "new";
  saveStore();
  renderAll();
  setStatus(accountStatus, "口座を削除しました", "ok");
}

// ===== 表示の切替 =====
function renderAll() {
  renderTabs();
  renderAccountSection();
  const acc = getCurrentAccount();
  const inNew = formMode === "new" || !acc;
  accountSection.classList.toggle("hidden", !inNew);
  importSection.classList.toggle("hidden", inNew);
  mappingSection.classList.add("hidden");
  remapBtn.classList.toggle("hidden", !(acc && acc.mapping && lastImport));
  if (inNew) {
    editSection.classList.add("hidden");
    finalSection.classList.add("hidden");
    balanceAlert.classList.add("hidden");
  } else {
    renderTable();
  }
}

// ===== 文字コード判定付き読込 =====
function decodeBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}
function handleFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const buf = reader.result;
      const bytes = new Uint8Array(buf);
      // 旧形式 .xls（バイナリ）は非対応
      if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
        setStatus(fileStatus, "古いExcel形式(.xls)は読み込めません。Excelで「.xlsx」または「CSV」として保存し直してください。", "error");
        return;
      }
      const isZip = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
      const isXlsxName = /\.xlsx$/i.test(file.name || "");
      if (isZip || isXlsxName) {
        const records = await parseXlsx(buf);
        startImport(records);
      } else {
        startImport(parseDelimited(decodeBytes(buf), ","));
      }
    } catch (err) {
      setStatus(fileStatus, "読み込みに失敗しました: " + err.message, "error");
    }
  };
  reader.onerror = () => setStatus(fileStatus, "ファイルの読み込みに失敗しました", "error");
  reader.readAsArrayBuffer(file);
}

// ===== Excel(.xlsx) の読み込み =====
async function parseXlsx(buf) {
  const entries = readZipEntries(buf);
  let sheetEntryName = null;
  for (const name of entries.keys()) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(name)) {
      if (!sheetEntryName || name < sheetEntryName) sheetEntryName = name;
    }
  }
  if (!sheetEntryName) throw new Error("Excelのシートが見つかりませんでした");
  const sheetXml = await readZipEntryText(buf, entries.get(sheetEntryName));
  let shared = [];
  if (entries.has("xl/sharedStrings.xml")) {
    shared = parseSharedStrings(await readZipEntryText(buf, entries.get("xl/sharedStrings.xml")));
  }
  return parseSheetXml(sheetXml, shared);
}

function readZipEntries(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const len = bytes.length;
  let eocd = -1;
  for (let i = len - 22; i >= 0 && i >= len - 22 - 65536; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Excelファイルの形式を確認できませんでした");
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder("utf-8");
  for (let e = 0; e < count; e++) {
    if (view.getUint32(off, true) !== 0x02014b50) break;
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readZipEntryText(buf, entry) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const lnLen = view.getUint16(entry.localOff + 26, true);
  const leLen = view.getUint16(entry.localOff + 28, true);
  const dataStart = entry.localOff + 30 + lnLen + leLen;
  const comp = bytes.subarray(dataStart, dataStart + entry.compSize);
  let raw;
  if (entry.method === 0) {
    raw = comp;
  } else if (entry.method === 8) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("このブラウザはExcelの展開に対応していません（最新のChrome/Edgeをご利用ください）");
    }
    const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    raw = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    throw new Error("未対応の圧縮方式です (" + entry.method + ")");
  }
  return new TextDecoder("utf-8").decode(raw);
}

function parseSharedStrings(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const sis = doc.getElementsByTagName("si");
  const out = [];
  for (let i = 0; i < sis.length; i++) {
    const ts = sis[i].getElementsByTagName("t");
    let s = "";
    for (let j = 0; j < ts.length; j++) s += ts[j].textContent;
    out.push(s);
  }
  return out;
}

function colRefToIndex(ref) {
  const m = String(ref || "").match(/^([A-Za-z]+)/);
  if (!m) return 0;
  const s = m[1].toUpperCase();
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1;
}

function parseSheetXml(xml, shared) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const rows = doc.getElementsByTagName("row");
  const rowData = [];
  let maxCol = 0;
  for (let i = 0; i < rows.length; i++) {
    const cs = rows[i].getElementsByTagName("c");
    const cells = [];
    for (let j = 0; j < cs.length; j++) {
      const c = cs[j];
      const ci = colRefToIndex(c.getAttribute("r"));
      const t = c.getAttribute("t");
      let val = "";
      if (t === "inlineStr") {
        const ts = c.getElementsByTagName("t");
        for (let k = 0; k < ts.length; k++) val += ts[k].textContent;
      } else {
        const vEl = c.getElementsByTagName("v")[0];
        const rawVal = vEl ? vEl.textContent : "";
        if (t === "s") {
          const si = parseInt(rawVal, 10);
          val = shared[si] != null ? shared[si] : "";
        } else {
          val = rawVal;
        }
      }
      cells[ci] = val;
      if (ci > maxCol) maxCol = ci;
    }
    rowData.push(cells);
  }
  const result = [];
  rowData.forEach((cells) => {
    const row = [];
    for (let i = 0; i <= maxCol; i++) row.push(cells[i] != null ? cells[i] : "");
    if (row.some((v) => String(v).trim() !== "")) result.push(row);
  });
  return result;
}
function handlePaste() {
  const text = pasteArea.value;
  if (!text.trim()) {
    setStatus(fileStatus, "貼り付け欄が空です", "error");
    return;
  }
  try {
    const delimiter = text.includes("\t") ? "\t" : ",";
    startImport(parseDelimited(text, delimiter));
  } catch (err) {
    setStatus(fileStatus, "取込に失敗しました: " + err.message, "error");
  }
}

// ===== 区切り文字パーサ =====
function parseDelimited(text, delimiter) {
  const records = [];
  let field = "";
  let record = [];
  let inQuotes = false;
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === delimiter) { record.push(field); field = ""; }
      else if (c === "\n") { record.push(field); field = ""; records.push(record); record = []; }
      else { field += c; }
    }
  }
  if (field !== "" || record.length > 0) { record.push(field); records.push(record); }
  return records.filter((r) => r.some((v) => v.trim() !== ""));
}

function splitHeaderAndData(records, headerInFirstRow) {
  if (records.length === 0) throw new Error("データが空です");
  const colCount = records.reduce((m, r) => Math.max(m, r.length), 0);
  let columns, dataRows;
  if (headerInFirstRow) {
    columns = [];
    for (let i = 0; i < colCount; i++) {
      const name = (records[0][i] || "").trim();
      columns.push(name || `列${i + 1}`);
    }
    dataRows = records.slice(1);
  } else {
    columns = [];
    for (let i = 0; i < colCount; i++) columns.push(`列${i + 1}`);
    dataRows = records;
  }
  dataRows = dataRows.map((r) => columns.map((_, i) => (r[i] !== undefined ? r[i] : "")));
  return { columns, dataRows };
}

// ===== 取込開始 =====
function startImport(records) {
  const acc = getCurrentAccount();
  if (!acc) {
    setStatus(fileStatus, "先に口座を登録・選択してください", "error");
    return;
  }
  const parsed = splitHeaderAndData(records, hasHeader.checked);
  lastImport = { columns: parsed.columns, dataRows: parsed.dataRows, hasHeader: hasHeader.checked };

  if (acc.mapping) {
    const res = mergeIntoAccount(acc, lastImport.dataRows, acc.mapping.roles);
    saveStore();
    renderTable();
    remapBtn.classList.remove("hidden");
    setStatus(fileStatus, importMessage(res, acc), "ok");
  } else {
    openMapping(guessRoles(lastImport.columns, lastImport.hasHeader));
  }
}
function importMessage(res, acc) {
  return (
    `取り込み完了：新規${res.added}件を追加` +
    (res.dup ? `／重複${res.dup}件は除外` : "") +
    (res.skipped ? `／見出し・空行${res.skipped}件は除外` : "") +
    `（合計${acc.transactions.length}件）`
  );
}

// ヘッダ名から役割を推測（最長一致で割り当て）
function guessRoles(columns, headerInFirstRow) {
  const roles = { date: null, withdrawal: null, deposit: null, amount: null, balance: null, description: null };
  if (!headerInFirstRow) return roles;
  const colBest = columns.map((name) => {
    let best = null, bestLen = 0;
    for (const role of ROLES) {
      for (const k of GUESS[role.key]) {
        if (name.includes(k) && k.length > bestLen) { best = role.key; bestLen = k.length; }
      }
    }
    return best;
  });
  const used = new Set();
  ROLES.forEach((role) => {
    for (let i = 0; i < columns.length; i++) {
      if (used.has(i)) continue;
      if (colBest[i] === role.key) { roles[role.key] = i; used.add(i); break; }
    }
  });
  return roles;
}

// ===== マッピングUI（プレビュー表＋色つき項目ボタン） =====
let mapState = null; // { roles: {key:colIndex|null}, active: roleKey|null }

function openMapping(prefillRoles) {
  if (!lastImport) return;
  mapState = { roles: {}, active: null };
  ROLES.forEach((r) => {
    const pre = prefillRoles ? prefillRoles[r.key] : null;
    if (r.multi) {
      mapState.roles[r.key] = pre == null ? [] : Array.isArray(pre) ? pre.slice() : [pre];
    } else {
      mapState.roles[r.key] = pre != null ? pre : null;
    }
  });
  renderMapping();
  setStatus(mappingStatus, "", "");
  mappingSection.classList.remove("hidden");
  mappingSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function assignedCols(roleKey) {
  const v = mapState.roles[roleKey];
  if (Array.isArray(v)) return v;
  return v != null ? [v] : [];
}
function roleForColumn(colIndex) {
  return ROLES.find((r) => assignedCols(r.key).includes(colIndex)) || null;
}
function removeColumnFromOthers(colIndex, exceptKey) {
  ROLES.forEach((r) => {
    if (r.key === exceptKey) return;
    if (Array.isArray(mapState.roles[r.key])) {
      mapState.roles[r.key] = mapState.roles[r.key].filter((c) => c !== colIndex);
    } else if (mapState.roles[r.key] === colIndex) {
      mapState.roles[r.key] = null;
    }
  });
}

function assignColumn(colIndex) {
  if (!mapState.active) {
    setStatus(mappingStatus, "先に上の項目ボタン（日付・摘要・出金額など）を選んでください", "error");
    return;
  }
  const roleDef = ROLES.find((r) => r.key === mapState.active);
  if (roleDef.multi) {
    const arr = Array.isArray(mapState.roles[roleDef.key]) ? mapState.roles[roleDef.key] : [];
    const at = arr.indexOf(colIndex);
    if (at >= 0) {
      arr.splice(at, 1); // 再クリックで解除
    } else {
      removeColumnFromOthers(colIndex, roleDef.key);
      arr.push(colIndex);
      arr.sort((a, b) => a - b);
    }
    mapState.roles[roleDef.key] = arr;
  } else if (mapState.roles[roleDef.key] === colIndex) {
    mapState.roles[roleDef.key] = null; // 同じ列を再クリックで解除
  } else {
    removeColumnFromOthers(colIndex, roleDef.key);
    mapState.roles[roleDef.key] = colIndex;
  }
  setStatus(mappingStatus, "", "");
  renderMapping();
}

function renderMapping() {
  const { columns, dataRows } = lastImport;
  mappingFields.innerHTML = "";

  // 項目ボタンのバー
  const bar = document.createElement("div");
  bar.className = "role-bar";
  ROLES.forEach((r) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "role-btn" + (mapState.active === r.key ? " active" : "");
    btn.style.setProperty("--role-color", r.color);
    btn.style.setProperty("--role-tint", r.tint);

    const swatch = document.createElement("span");
    swatch.className = "role-swatch";
    btn.appendChild(swatch);

    const lbl = document.createElement("span");
    lbl.className = "role-label";
    lbl.textContent = r.label + (r.required ? " ＊" : "") + (r.multi ? "（複数可）" : "");
    btn.appendChild(lbl);

    const cols = assignedCols(r.key);
    const assign = document.createElement("span");
    assign.className = "role-assign";
    assign.textContent = cols.length ? cols.map((i) => columns[i]).join("、") : "未設定";
    btn.appendChild(assign);

    if (cols.length) {
      const x = document.createElement("span");
      x.className = "role-clear";
      x.textContent = "✕";
      x.title = "すべて解除";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        mapState.roles[r.key] = r.multi ? [] : null;
        renderMapping();
      });
      btn.appendChild(x);
    }

    btn.addEventListener("click", () => {
      mapState.active = mapState.active === r.key ? null : r.key;
      renderMapping();
    });
    bar.appendChild(btn);
  });
  mappingFields.appendChild(bar);

  // 操作ヒント
  const tip = document.createElement("p");
  tip.className = "hint map-tip";
  if (mapState.active) {
    const ar = ROLES.find((r) => r.key === mapState.active);
    const multiNote = ar.multi ? "複数の列を選べます。" : "";
    tip.textContent = `「${ar.label}」を選択中です。下の表で、この項目にあたる列をクリックしてください。${multiNote}（同じ列をもう一度押すと解除）`;
  } else {
    tip.textContent = "上の項目ボタンを選んでから、下の表で対応する列をクリックします。最低限「日付＊」を設定してください。摘要は複数の列を選べます。";
  }
  mappingFields.appendChild(tip);

  // プレビュー表
  const wrap = document.createElement("div");
  wrap.className = "map-table-wrap";
  const table = document.createElement("table");
  table.className = "map-table";

  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "map-corner";
  htr.appendChild(corner);
  columns.forEach((c, i) => {
    const th = document.createElement("th");
    th.className = "map-col-head";
    const role = roleForColumn(i);
    if (role) {
      th.classList.add("assigned");
      th.style.setProperty("--role-color", role.color);
      th.style.setProperty("--role-tint", role.tint);
    }
    const name = document.createElement("div");
    name.className = "map-col-name";
    name.textContent = c;
    th.appendChild(name);
    if (role) {
      const tag = document.createElement("span");
      tag.className = "map-col-tag";
      tag.textContent = role.label;
      th.appendChild(tag);
    }
    th.addEventListener("click", () => assignColumn(i));
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  dataRows.slice(0, 8).forEach((row, ri) => {
    const tr = document.createElement("tr");
    const rh = document.createElement("td");
    rh.className = "map-row-head";
    rh.textContent = String(ri + 1);
    tr.appendChild(rh);
    columns.forEach((c, i) => {
      const td = document.createElement("td");
      const role = roleForColumn(i);
      if (role) {
        td.classList.add("assigned");
        td.style.setProperty("--role-tint", role.tint);
      }
      td.textContent = row[i] != null ? row[i] : "";
      td.addEventListener("click", () => assignColumn(i));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  mappingFields.appendChild(wrap);
}

function readMappingRoles() {
  const roles = { date: null, withdrawal: null, deposit: null, amount: null, balance: null, description: null };
  if (mapState) {
    ROLES.forEach((r) => {
      const v = mapState.roles[r.key];
      roles[r.key] = r.multi ? (Array.isArray(v) ? v.slice() : []) : v;
    });
  }
  return roles;
}
function applyMapping() {
  const acc = getCurrentAccount();
  if (!acc || !lastImport) return;
  const roles = readMappingRoles();
  if (roles.date == null) {
    setStatus(mappingStatus, "「日付」の列を選んでください", "error");
    return;
  }
  acc.mapping = { hasHeader: lastImport.hasHeader, columns: lastImport.columns.slice(), roles };
  const res = mergeIntoAccount(acc, lastImport.dataRows, roles);
  saveStore();
  mappingSection.classList.add("hidden");
  remapBtn.classList.remove("hidden");
  renderTable();
  setStatus(fileStatus, importMessage(res, acc), "ok");
}

// ===== 重複判定 =====
function normKey(v) {
  return String(v == null ? "" : v).replace(/[,\s　¥￥円]/g, "").trim();
}
function rowKey(cells, roles) {
  const part = (r) => (r == null ? "" : normKey(cells[r]));
  const descPart = descCols(roles).map((i) => normKey(cells[i])).join("|");
  return [part(roles.date), part(roles.withdrawal), part(roles.deposit), part(roles.amount), part(roles.balance), descPart].join("");
}

// ===== 取り込み（重複除外＋学習の事前反映） =====
function mergeIntoAccount(acc, dataRows, roles) {
  const cols = acc.mapping.columns;
  const existing = new Set(acc.transactions.map((t) => rowKey(t.cells, roles)));
  let added = 0, dup = 0, skipped = 0;
  dataRows.forEach((row) => {
    const cells = cols.map((_, i) => (row[i] !== undefined ? row[i] : ""));
    if (!isMeaningfulRow(roles, cells)) { skipped++; return; } // 見出し/空行などを除外
    const key = rowKey(cells, roles);
    if (existing.has(key)) { dup++; return; }
    existing.add(key);
    const dir = dirOf(roles, cells);
    const learned = getLearned(acc, dir, descOf(roles, cells));
    acc.transactions.push({
      cells,
      entity: learned ? learned.entity : "",
      property: learned ? learned.property || "" : "",
      memo: "",
      saved: false,
      items: learned ? learned.items.map((it) => ({ category: it.category, amount: it.amount, cdir: it.cdir || dir })) : [],
    });
    added++;
  });
  return { added, dup, skipped };
}

// ===== テーブル描画 =====
function renderTable() {
  const acc = getCurrentAccount();
  if (!acc || !acc.mapping) {
    editSection.classList.add("hidden");
    finalSection.classList.add("hidden");
    balanceAlert.classList.add("hidden");
    return;
  }
  const roles = acc.mapping.roles;
  renderEditTable(acc, roles);
  renderFinalTable(acc, roles);
  renderBalanceAlert(acc);
}

function renderBalanceAlert(acc) {
  const res = checkBalanceContinuity(acc);
  if (res.ok) {
    balanceAlert.classList.add("hidden");
    balanceAlert.innerHTML = "";
    return;
  }
  balanceAlert.classList.remove("hidden");
  balanceAlert.innerHTML = "";
  const title = document.createElement("strong");
  title.textContent = "⚠ 残高がつながっていません（通帳の取り込み漏れの可能性）";
  balanceAlert.appendChild(title);
  res.gaps.forEach((g) => {
    const p = document.createElement("div");
    p.textContent = `${g.from}から${g.to}にかけての残高が合いません。その期間の通帳をアップロードしてください。`;
    balanceAlert.appendChild(p);
  });
}

// 「2. 明細の確認・分類の入力」＝未保存の取引のみ
function renderEditTable(acc, roles) {
  const unsaved = acc.transactions.filter((t) => !t.saved);
  if (unsaved.length === 0) {
    editSection.classList.add("hidden");
    return;
  }
  editSection.classList.remove("hidden");
  const tcols = topColumns(roles);
  rowSummary.textContent = `未保存：${unsaved.length}件`;

  // ヘッダ（役割名を使用・摘要の隣に物件名）
  tableHead.innerHTML = "";
  const headRow = document.createElement("tr");
  tcols.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c.label;
    if (c.num) th.classList.add("num");
    headRow.appendChild(th);
  });
  headRow.appendChild(document.createElement("th")); // 削除ボタン列
  tableHead.appendChild(headRow);

  const totalCols = tcols.length + 1;

  // 本体（1取引＝2行：通帳データ＋分類入力を一段下げて表示）
  tableBody.innerHTML = "";
  acc.transactions.forEach((tx, rowIndex) => {
    if (tx.saved) return;
    if (!tx.items) tx.items = [];
    if (tx.entity == null) tx.entity = "";
    const dir = dirOf(roles, tx.cells);

    // 1行目：通帳データ（＋物件名入力）
    const trMain = document.createElement("tr");
    trMain.className = "tx-main";
    tcols.forEach((c) => {
      const td = document.createElement("td");
      if (c.key === "__property") {
        td.className = "property-cell";
        td.appendChild(buildPropertyInput(acc, tx, dir));
      } else {
        td.textContent = displayValue(roles, tx.cells, c);
        if (c.num) td.classList.add("num");
      }
      trMain.appendChild(td);
    });
    const tdDel = document.createElement("td");
    tdDel.className = "del-cell";
    const delBtn = document.createElement("button");
    delBtn.className = "del-btn";
    delBtn.textContent = "✕";
    delBtn.title = "この取引を削除";
    delBtn.addEventListener("click", () => {
      acc.transactions.splice(rowIndex, 1);
      saveStore();
      renderTable();
    });
    tdDel.appendChild(delBtn);
    trMain.appendChild(tdDel);
    tableBody.appendChild(trMain);

    // 2行目：分類入力（一段下げ）
    const trDetail = document.createElement("tr");
    trDetail.className = "tx-detail";
    const tdDetail = document.createElement("td");
    tdDetail.colSpan = totalCols;
    tdDetail.appendChild(buildDetailInner(acc, tx, rowIndex, dir));
    trDetail.appendChild(tdDetail);
    tableBody.appendChild(trDetail);
  });
}

// 「3. 加筆後の通帳データ」＝保存済みの取引をExcel風に表示
function finalCategoryColumns(acc) {
  ensureCategories();
  const cols = [];
  const push = (c) => { if (c && !cols.includes(c)) cols.push(c); };
  store.categories["入金"].forEach(push);
  store.categories["出金"].forEach(push);
  acc.transactions.forEach((t) => (t.items || []).forEach((it) => push(it.category)));
  return cols;
}
function fmtNum(v) {
  const n = toNumber(v);
  return n === 0 ? "" : n.toLocaleString("ja-JP");
}
function renderFinalTable(acc, roles) {
  const saved = acc.transactions.filter((t) => t.saved);
  if (saved.length === 0) {
    finalSection.classList.add("hidden");
    return;
  }
  finalSection.classList.remove("hidden");
  finalSummary.textContent = `保存済み：${saved.length}件`;
  const catCols = finalCategoryColumns(acc);

  // ヘッダ
  finalTableHead.innerHTML = "";
  const htr = document.createElement("tr");
  const baseCols = [
    { label: "日付" },
    { label: "摘要" },
    { label: "入金", num: true },
    { label: "出金", num: true },
    { label: "残高", num: true },
    { label: "法人/個人" },
    { label: "物件名" },
  ];
  baseCols.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c.label;
    if (c.num) th.classList.add("num");
    htr.appendChild(th);
  });
  catCols.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c;
    th.classList.add("num");
    htr.appendChild(th);
  });
  const thMemo = document.createElement("th");
  thMemo.textContent = "メモ";
  htr.appendChild(thMemo);
  htr.appendChild(document.createElement("th")); // 編集に戻す列
  finalTableHead.appendChild(htr);

  // 本体
  finalTableBody.innerHTML = "";
  acc.transactions.forEach((tx, rowIndex) => {
    if (!tx.saved) return;
    const dir = dirOf(roles, tx.cells);
    const amt = amtOf(roles, tx.cells);
    const tr = document.createElement("tr");

    const cells = [
      { v: roles.date != null ? String(tx.cells[roles.date] || "") : "" },
      { v: descOf(roles, tx.cells) },
      { v: dir === "入金" ? fmtNum(amt) : "", num: true },
      { v: dir === "出金" ? fmtNum(amt) : "", num: true },
      { v: roles.balance != null ? fmtNum(tx.cells[roles.balance]) : "", num: true },
      { v: tx.entity || "" },
      { v: tx.property || "" },
    ];
    cells.forEach((c) => {
      const td = document.createElement("td");
      td.textContent = c.v;
      if (c.num) td.classList.add("num");
      tr.appendChild(td);
    });
    catCols.forEach((cat) => {
      const td = document.createElement("td");
      td.classList.add("num");
      let sum = 0;
      let has = false;
      (tx.items || []).forEach((i) => {
        if (i.category === cat) { has = true; sum += toNumber(i.amount) * ((i.cdir || dir) === dir ? 1 : -1); }
      });
      td.textContent = has ? fmtNum(sum) : "";
      tr.appendChild(td);
    });
    const tdMemo = document.createElement("td");
    tdMemo.textContent = tx.memo || "";
    tr.appendChild(tdMemo);

    const tdBack = document.createElement("td");
    const backBtn = document.createElement("button");
    backBtn.className = "btn back-btn";
    backBtn.textContent = "編集に戻す";
    backBtn.addEventListener("click", () => {
      tx.saved = false;
      saveStore();
      renderTable();
    });
    tdBack.appendChild(backBtn);
    tr.appendChild(tdBack);

    finalTableBody.appendChild(tr);
  });
}

// 分類セル：法人/個人の選択と、分類ごとの金額欄を常に表示
// items は {category, amount, cdir} を持つ。cdir はその分類の所属方向（入金/出金）。
// 取引方向(txDir)と同じ cdir は加算（収入/支出）、反対の cdir は控除（マイナス）として扱う。
const deductionOpen = new WeakSet(); // 控除欄を開いている取引

function oppositeDir(dir) {
  return dir === "入金" ? "出金" : "入金";
}
// 旧データ（cdir なし）は取引方向に属する加算項目として補正
function normalizeItemDirs(tx, txDir) {
  (tx.items || []).forEach((it) => { if (!it.cdir) it.cdir = txDir; });
}
function getItemAmount(tx, cdir, category) {
  const it = (tx.items || []).find((i) => i.category === category && i.cdir === cdir);
  return it && it.amount != null ? String(it.amount) : "";
}
function setItemAmount(tx, cdir, category, value) {
  if (!tx.items) tx.items = [];
  const idx = tx.items.findIndex((i) => i.category === category && i.cdir === cdir);
  if (value === "" || value == null) {
    if (idx >= 0) tx.items.splice(idx, 1);
  } else if (idx >= 0) {
    tx.items[idx].amount = value;
  } else {
    tx.items.push({ category, amount: value, cdir });
  }
}
function hasDeductionItems(tx, txDir) {
  return (tx.items || []).some((it) => (it.cdir || txDir) !== txDir && String(it.amount).trim() !== "");
}

function buildPropertyInput(acc, tx, dir) {
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "row-property";
  inp.placeholder = "物件名";
  inp.value = tx.property || "";
  inp.addEventListener("input", () => {
    tx.property = inp.value;
    learnFromTx(acc, tx, dir);
    saveStore();
  });
  inp.addEventListener("change", () => {
    // 同じ摘要の未保存取引にも自動反映
    const roles = acc.mapping.roles;
    const desc = descOf(roles, tx.cells);
    if (!desc) return;
    let changed = false;
    acc.transactions.forEach((t) => {
      if (!t.saved && t !== tx && dirOf(roles, t.cells) === dir && descOf(roles, t.cells) === desc && t.property !== tx.property) {
        t.property = tx.property;
        changed = true;
      }
    });
    if (changed) { saveStore(); renderTable(); }
  });
  return inp;
}

function buildDetailInner(acc, tx, rowIndex, dir) {
  const inner = document.createElement("div");
  inner.className = "tx-detail-inner";

  // メタ行：区分・法人個人・メモ・合計
  const meta = document.createElement("div");
  meta.className = "detail-meta";

  const badge = document.createElement("span");
  badge.className = "dir-badge " + (dir === "入金" ? "dir-in" : dir === "出金" ? "dir-out" : "dir-none");
  badge.textContent = dir || "区分不明";
  meta.appendChild(badge);

  const entWrap = document.createElement("span");
  entWrap.className = "entity-choice seg";
  ["法人", "個人"].forEach((v) => {
    const lab = document.createElement("label");
    const rb = document.createElement("input");
    rb.type = "radio";
    rb.name = "entity_" + acc.id + "_" + rowIndex;
    rb.value = v;
    rb.checked = tx.entity === v;
    rb.addEventListener("change", () => {
      tx.entity = v;
      learnFromTx(acc, tx, dir);
      saveStore();
    });
    lab.appendChild(rb);
    lab.appendChild(document.createTextNode(v));
    entWrap.appendChild(lab);
  });
  meta.appendChild(entWrap);

  meta.appendChild(
    buildTxField("メモ", "memo-field", "メモを入力", tx.memo || "", (val) => {
      tx.memo = val;
      saveStore();
    })
  );
  inner.appendChild(meta);

  if (!dir) {
    const note = document.createElement("span");
    note.className = "empty";
    note.textContent = "入金/出金が判別できないため内訳を入力できません";
    meta.appendChild(note);
    return inner;
  }

  normalizeItemDirs(tx, dir);
  const opp = oppositeDir(dir);
  const showDeduction = deductionOpen.has(tx) || hasDeductionItems(tx, dir);

  const totalEl = document.createElement("span");
  totalEl.className = "cat-total";
  function refreshTotal() {
    const income = (tx.items || []).reduce((s, it) => s + (it.cdir === dir ? toNumber(it.amount) : 0), 0);
    const deduct = (tx.items || []).reduce((s, it) => s + (it.cdir === opp ? toNumber(it.amount) : 0), 0);
    const net = income - deduct;
    const amt = amtOf(acc.mapping.roles, tx.cells);
    const diff = amt - net;
    totalEl.innerHTML = "";
    const mainLabel = dir === "入金" ? "収入" : "支出";
    const txt = deduct > 0
      ? `取引 ${yen(amt)}　${mainLabel} ${yen(income)} − 控除 ${yen(deduct)} ＝ ${yen(net)}　差額 `
      : `取引 ${yen(amt)}　入力 ${yen(net)}　差額 `;
    totalEl.appendChild(document.createTextNode(txt));
    const span = document.createElement("span");
    span.className = diff === 0 ? "ok" : "ng";
    span.textContent = yen(diff) + (diff === 0 ? "（一致）" : "");
    totalEl.appendChild(span);
  }

  // 収入（＋）行
  const incLine = document.createElement("div");
  incLine.className = "cat-line";
  incLine.appendChild(buildGroupLabel(dir === "入金" ? "収入(＋)" : "支出(＋)", false));
  categoriesForTx(dir, tx).forEach((cat) => {
    incLine.appendChild(buildCatItem(acc, tx, dir, dir, cat, refreshTotal));
  });
  inner.appendChild(incLine);

  // 控除（−）行（必要なときだけ）
  const dedLine = document.createElement("div");
  dedLine.className = "cat-line";
  if (showDeduction) {
    dedLine.appendChild(buildGroupLabel("控除(−)", true));
    categoriesForTx(opp, tx).forEach((cat) => {
      dedLine.appendChild(buildCatItem(acc, tx, dir, opp, cat, refreshTotal));
    });
  } else {
    const addDed = document.createElement("button");
    addDed.type = "button";
    addDed.className = "add-deduction-btn";
    addDed.textContent = "＋ 控除（−）項目";
    addDed.title = "敷金返金など、入金から差し引く項目を入力する";
    addDed.addEventListener("click", () => {
      deductionOpen.add(tx);
      renderTable();
    });
    dedLine.appendChild(addDed);
  }
  inner.appendChild(dedLine);

  // 合計・差額（独立した行・左揃えで位置を固定）
  const totalLine = document.createElement("div");
  totalLine.className = "cat-total-line";
  totalLine.appendChild(totalEl);
  inner.appendChild(totalLine);

  refreshTotal();
  return inner;
}

function buildGroupLabel(text, minus) {
  const el = document.createElement("span");
  el.className = "cat-group-label" + (minus ? " minus" : " plus");
  el.textContent = text;
  return el;
}

function buildCatItem(acc, tx, txDir, cdir, cat, refreshTotal) {
  const item = document.createElement("div");
  item.className = "cat-item" + (cdir === txDir ? "" : " minus");
  const name = document.createElement("span");
  name.className = "cat-name";
  name.textContent = cat;
  item.appendChild(name);

  const amtInp = document.createElement("input");
  amtInp.type = "text";
  amtInp.inputMode = "numeric";
  amtInp.placeholder = "0";
  amtInp.value = formatAmountInput(getItemAmount(tx, cdir, cat));
  amtInp.addEventListener("input", () => {
    const f = formatAmountInput(amtInp.value);
    amtInp.value = f;
    setItemAmount(tx, cdir, cat, f);
    refreshTotal();
    learnFromTx(acc, tx, txDir);
    saveStore();
  });
  const field = document.createElement("div");
  field.className = "amount-field";
  const yenMark = document.createElement("span");
  yenMark.className = "yen";
  yenMark.textContent = cdir === txDir ? "¥" : "−¥";
  field.appendChild(yenMark);
  field.appendChild(amtInp);
  item.appendChild(field);
  return item;
}

function buildTxField(label, cls, placeholder, value, onInput) {
  const wrap = document.createElement("div");
  wrap.className = "tx-field " + cls;
  const lab = document.createElement("span");
  lab.className = "tx-field-label";
  lab.textContent = label;
  wrap.appendChild(lab);
  const inp = document.createElement("input");
  inp.type = "text";
  inp.placeholder = placeholder;
  inp.value = value;
  inp.addEventListener("input", () => onInput(inp.value));
  wrap.appendChild(inp);
  return wrap;
}

function learnFromTx(acc, tx, dir) {
  setLearned(acc, dir, descOf(acc.mapping.roles, tx.cells), tx.entity, tx.property, tx.items);
}

// ===== CSV出力（一括・口座ごと） =====
function escapeField(value) {
  const v = value == null ? "" : String(value);
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
function parseYearMonth(s) {
  const m = String(s || "").match(/(\d{4})\s*[\/\-\.年]\s*(\d{1,2})/);
  if (m) return { y: +m[1], m: +m[2] };
  return null;
}
function buildCategorizedCSV(acc, fromYM, toYM) {
  const roles = acc.mapping.roles;
  const headers = ["銀行名", "口座番号", "日付", "区分", "摘要", "取引金額", "残高", "法人/個人", "物件名", "分類", "金額", "メモ"];
  const lines = [headers.map(escapeField).join(",")];
  acc.transactions.forEach((tx) => {
    const dateCell = roles.date != null ? String(tx.cells[roles.date] || "") : "";
    if (fromYM != null && toYM != null) {
      const ym = parseYearMonth(dateCell);
      if (ym) {
        const n = ym.y * 100 + ym.m;
        if (n < fromYM || n > toYM) return;
      }
    }
    const dir = dirOf(roles, tx.cells);
    const amt = amtOf(roles, tx.cells);
    const desc = descOf(roles, tx.cells);
    const bal = roles.balance != null ? String(tx.cells[roles.balance] || "") : "";
    const common = [acc.bankName, acc.accountNumber, dateCell, dir, desc, String(amt), bal, tx.entity || "", tx.property || ""];
    const items = tx.items && tx.items.length ? tx.items : [{ category: "", amount: "", cdir: dir }];
    items.forEach((it) => {
      // 控除（取引方向と反対）の項目は金額をマイナスで出力（合計＝取引額になる）
      const sign = (it.cdir || dir) === dir ? 1 : -1;
      const amount = it.amount === "" || it.amount == null ? "" : String(toNumber(it.amount) * sign);
      const row = common.concat([it.category || "", amount, tx.memo || ""]);
      lines.push(row.map(escapeField).join(","));
    });
  });
  return lines.join("\r\n");
}
function sanitizeName(s) {
  return String(s || "").replace(/[\\\/:*?"<>|]/g, "_").trim();
}
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function downloadAccountCSV(acc, fromYM, toYM, suffix) {
  const csv = buildCategorizedCSV(acc, fromYM, toYM);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const blob = new Blob([bom, csv], { type: "text/csv;charset=utf-8" });
  const base = sanitizeName(acc.bankName + (acc.accountNumber ? "_" + acc.accountNumber : ""));
  triggerDownload(blob, `${base}_${suffix}.csv`);
}
function bulkDownload() {
  const targets = store.accounts.filter((a) => a.mapping && a.transactions.length);
  if (targets.length === 0) {
    setStatus(exportStatus, "出力できるデータがありません", "error");
    return;
  }
  let fromYM = null, toYM = null, suffix = "全期間";
  if (!allPeriod.checked) {
    fromYM = +fromYear.value * 100 + +fromMonth.value;
    toYM = +toYear.value * 100 + +toMonth.value;
    if (fromYM > toYM) {
      setStatus(exportStatus, "期間の指定が逆になっています（開始＜終了にしてください）", "error");
      return;
    }
    suffix = `${fromYear.value}-${String(fromMonth.value).padStart(2, "0")}_${toYear.value}-${String(toMonth.value).padStart(2, "0")}`;
  }
  targets.forEach((acc, i) => {
    setTimeout(() => downloadAccountCSV(acc, fromYM, toYM, suffix), i * 400);
  });
  setStatus(exportStatus, `${targets.length}口座分のCSVをダウンロードします（ブラウザが複数ファイルの許可を求めたら「許可」してください）`, "ok");
}

// ===== バックアップ／復元 =====
function backupData() {
  const json = JSON.stringify(store, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const today = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `通帳ツール_バックアップ_${today}.json`);
  setStatus(backupStatus, "バックアップを保存しました", "ok");
}
function restoreData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(reader.result);
      if (!obj || !Array.isArray(obj.accounts)) throw new Error("バックアップファイルの形式が正しくありません");
      const ok = confirm("現在のデータをバックアップの内容で置き換えます。今のデータは消えます。よろしいですか？（必要なら先に「バックアップを保存」してください）");
      if (!ok) return;
      store = obj;
      if (!store.selectedAccountId && store.accounts.length) store.selectedAccountId = store.accounts[0].id;
      formMode = store.accounts.length ? "edit" : "new";
      lastImport = null;
      ensureCategories();
      cleanupBlankTransactions();
      saveStore();
      renderCategorySettings();
      renderAll();
      setStatus(backupStatus, `復元しました（口座${store.accounts.length}件）`, "ok");
    } catch (err) {
      setStatus(backupStatus, "復元に失敗しました: " + err.message, "error");
    }
  };
  reader.onerror = () => setStatus(backupStatus, "ファイルの読み込みに失敗しました", "error");
  reader.readAsText(file);
}

// ===== 期間セレクタの初期化 =====
function populateRange() {
  const now = new Date();
  const thisYear = now.getFullYear();
  for (let y = thisYear + 1; y >= 2015; y--) {
    [fromYear, toYear].forEach((sel) => {
      const o = document.createElement("option");
      o.value = String(y);
      o.textContent = String(y);
      sel.appendChild(o);
    });
  }
  for (let m = 1; m <= 12; m++) {
    [fromMonth, toMonth].forEach((sel) => {
      const o = document.createElement("option");
      o.value = String(m);
      o.textContent = String(m);
      sel.appendChild(o);
    });
  }
  fromYear.value = String(thisYear);
  fromMonth.value = "1";
  toYear.value = String(thisYear);
  toMonth.value = "12";
  syncRange();
}
function syncRange() {
  rangeSelectors.classList.toggle("disabled", allPeriod.checked);
}

// ===== 分類の管理（設定） =====
function renderCategorySettings() {
  ensureCategories();
  categoryManager.innerHTML = "";
  [["入金", "入金の分類"], ["出金", "出金の分類"]].forEach(([dir, title]) => {
    const group = document.createElement("div");
    group.className = "cat-group";
    const h = document.createElement("h4");
    h.textContent = title;
    group.appendChild(h);

    const list = document.createElement("div");
    list.className = "cat-chip-list";
    store.categories[dir].forEach((cat, idx) => {
      const chip = document.createElement("span");
      chip.className = "cat-chip";
      chip.appendChild(document.createTextNode(cat));
      const x = document.createElement("button");
      x.type = "button";
      x.className = "cat-chip-del";
      x.textContent = "✕";
      x.title = "削除";
      x.addEventListener("click", () => {
        store.categories[dir].splice(idx, 1);
        saveStore();
        renderCategorySettings();
        renderTable();
      });
      chip.appendChild(x);
      list.appendChild(chip);
    });
    if (store.categories[dir].length === 0) {
      const e = document.createElement("span");
      e.className = "empty";
      e.textContent = "分類がありません";
      list.appendChild(e);
    }
    group.appendChild(list);

    const addRow = document.createElement("div");
    addRow.className = "cat-add-row";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "新しい分類を入力";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn btn-primary";
    addBtn.textContent = "追加";
    function doAdd() {
      const name = input.value.trim();
      if (!name) return;
      if (!store.categories[dir].includes(name)) store.categories[dir].push(name);
      saveStore();
      input.value = "";
      renderCategorySettings();
      renderTable();
    }
    addBtn.addEventListener("click", doAdd);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });
    addRow.appendChild(input);
    addRow.appendChild(addBtn);
    group.appendChild(addRow);

    categoryManager.appendChild(group);
  });
}

// ===== イベント登録 =====
function openSettings() {
  renderCategorySettings();
  settingsOverlay.classList.remove("hidden");
  settingsDrawer.classList.add("open");
  settingsDrawer.setAttribute("aria-hidden", "false");
}
function closeSettings() {
  settingsOverlay.classList.add("hidden");
  settingsDrawer.classList.remove("open");
  settingsDrawer.setAttribute("aria-hidden", "true");
}
settingsBtn.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
settingsOverlay.addEventListener("click", closeSettings);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && settingsDrawer.classList.contains("open")) closeSettings();
});

editSave.addEventListener("click", () => {
  const acc = getCurrentAccount();
  if (!acc) return;
  const unsavedCount = acc.transactions.filter((t) => !t.saved).length;
  if (unsavedCount === 0) {
    setStatus(editStatus, "保存できる明細がありません", "");
    return;
  }
  const ok = confirm(
    `入力した${unsavedCount}件を保存します。\n\n保存すると、これらは「2. 明細の確認・分類の入力」の一覧から削除され、「3. 加筆後の通帳データ」に移動します。よろしいですか？`
  );
  if (!ok) return;
  acc.transactions.forEach((t) => { if (!t.saved) t.saved = true; });
  saveStore();
  renderTable();
});

accountSave.addEventListener("click", saveAccount);
accountCancel.addEventListener("click", cancelAccountForm);
accountDelete.addEventListener("click", deleteAccount);

fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
pasteBtn.addEventListener("click", handlePaste);
remapBtn.addEventListener("click", () => {
  const acc = getCurrentAccount();
  openMapping(acc && acc.mapping ? acc.mapping.roles : null);
});

mappingApply.addEventListener("click", applyMapping);
mappingCancel.addEventListener("click", () => {
  mappingSection.classList.add("hidden");
  setStatus(fileStatus, "取り込みを中止しました", "");
});

allPeriod.addEventListener("change", syncRange);
bulkDownloadBtn.addEventListener("click", bulkDownload);
backupBtn.addEventListener("click", backupData);
restoreInput.addEventListener("change", (e) => restoreData(e.target.files[0]));

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.tab;
    $("tab-file").classList.toggle("hidden", target !== "file");
    $("tab-paste").classList.toggle("hidden", target !== "paste");
  });
});

// ===== 初期化 =====
if (store.accounts.length === 0) {
  formMode = "new";
} else {
  formMode = "edit";
  if (!getCurrentAccount()) store.selectedAccountId = store.accounts[0].id;
}
ensureCategories();
cleanupBlankTransactions();
populateRange();
renderCategorySettings();
renderAll();
