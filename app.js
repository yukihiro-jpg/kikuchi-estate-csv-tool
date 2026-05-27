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

// マッピングで扱う役割
const ROLES = [
  { key: "date", label: "日付", required: true },
  { key: "withdrawal", label: "出金額" },
  { key: "deposit", label: "入金額" },
  { key: "amount", label: "入出金（1列・＋−で表現）" },
  { key: "balance", label: "残高" },
  { key: "description", label: "摘要（取引内容）" },
];

const GUESS = {
  date: ["日付", "年月日", "取引日", "お取引日"],
  withdrawal: ["出金", "お引出", "引出", "お支払", "支払", "引落", "出金金額"],
  deposit: ["入金", "お預入", "預入", "預り", "入金金額"],
  amount: ["入出金", "取引金額", "金額"],
  balance: ["残高", "残額"],
  description: ["摘要", "お取引内容", "取引内容", "内容", "明細", "備考", "メモ"],
};

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const accountSelect = $("account-select");
const accountNewBtn = $("account-new");
const accountEditBtn = $("account-edit");
const accountDeleteBtn = $("account-delete");
const accountForm = $("account-form");
const bankNameInput = $("bank-name");
const accountNumberInput = $("account-number");
const accountCancelBtn = $("account-cancel");
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

const exportSection = $("export-section");
const exportBtn = $("export-btn");
const exportName = $("export-name");
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

// ===== 口座管理 =====
function renderAccountSelect() {
  accountSelect.innerHTML = "";
  if (store.accounts.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "（口座が未登録です。右の「＋新しい口座を登録」から追加）";
    accountSelect.appendChild(opt);
    accountSelect.disabled = true;
    accountEditBtn.disabled = true;
    accountDeleteBtn.disabled = true;
    return;
  }
  accountSelect.disabled = false;
  accountEditBtn.disabled = false;
  accountDeleteBtn.disabled = false;
  store.accounts.forEach((a) => {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = `${a.bankName}　${a.accountNumber}`.trim();
    accountSelect.appendChild(opt);
  });
  if (!store.selectedAccountId || !getCurrentAccount()) {
    store.selectedAccountId = store.accounts[0].id;
  }
  accountSelect.value = store.selectedAccountId;
}

let formMode = "new";

function openAccountForm(mode) {
  formMode = mode;
  const acc = getCurrentAccount();
  if (mode === "edit" && acc) {
    bankNameInput.value = acc.bankName;
    accountNumberInput.value = acc.accountNumber;
  } else {
    bankNameInput.value = "";
    accountNumberInput.value = "";
  }
  accountForm.classList.remove("hidden");
  bankNameInput.focus();
}

function closeAccountForm() {
  accountForm.classList.add("hidden");
}

function saveAccount(e) {
  e.preventDefault();
  const bankName = bankNameInput.value.trim();
  const accountNumber = accountNumberInput.value.trim();
  if (!bankName) {
    setStatus(accountStatus, "銀行名を入力してください", "error");
    return;
  }
  if (formMode === "edit") {
    const acc = getCurrentAccount();
    if (acc) {
      acc.bankName = bankName;
      acc.accountNumber = accountNumber;
    }
    setStatus(accountStatus, "口座名を更新しました", "ok");
  } else {
    const id = "acc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    store.accounts.push({
      id,
      bankName,
      accountNumber,
      mapping: null,
      noteColumn: null,
      transactions: [],
    });
    store.selectedAccountId = id;
    setStatus(accountStatus, `口座「${bankName}」を登録しました`, "ok");
  }
  saveStore();
  closeAccountForm();
  renderAccountSelect();
  loadAccountView();
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
  saveStore();
  renderAccountSelect();
  loadAccountView();
  setStatus(accountStatus, "口座を削除しました", "ok");
}

// 口座選択時に表示を切り替える
function loadAccountView() {
  const acc = getCurrentAccount();
  mappingSection.classList.add("hidden");
  if (!acc) {
    importSection.classList.add("hidden");
    editSection.classList.add("hidden");
    exportSection.classList.add("hidden");
    return;
  }
  importSection.classList.remove("hidden");
  remapBtn.classList.toggle("hidden", !(acc.mapping && lastImport));
  setStatus(fileStatus, "", "");
  renderTable();
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
  reader.onload = () => {
    try {
      const text = decodeBytes(reader.result);
      const parsed = parseDelimited(text, ",");
      startImport(parsed);
    } catch (err) {
      setStatus(fileStatus, "読み込みに失敗しました: " + err.message, "error");
    }
  };
  reader.onerror = () => setStatus(fileStatus, "ファイルの読み込みに失敗しました", "error");
  reader.readAsArrayBuffer(file);
}

function handlePaste() {
  const text = pasteArea.value;
  if (!text.trim()) {
    setStatus(fileStatus, "貼り付け欄が空です", "error");
    return;
  }
  try {
    const delimiter = text.includes("\t") ? "\t" : ",";
    const parsed = parseDelimited(text, delimiter);
    startImport(parsed);
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

// パース結果 → {columns, dataRows}
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
  // 各行を列数にそろえる
  dataRows = dataRows.map((r) => columns.map((_, i) => (r[i] !== undefined ? r[i] : "")));
  return { columns, dataRows };
}

// ===== 取込開始：マッピングが必要か判定 =====
function startImport(records) {
  const acc = getCurrentAccount();
  if (!acc) {
    setStatus(fileStatus, "先に口座を登録・選択してください", "error");
    return;
  }
  const parsed = splitHeaderAndData(records, hasHeader.checked);
  lastImport = { columns: parsed.columns, dataRows: parsed.dataRows, hasHeader: hasHeader.checked };

  if (acc.mapping) {
    // 学習済み → 自動で取り込む
    const res = mergeIntoAccount(acc, lastImport.dataRows, acc.mapping.roles);
    saveStore();
    renderTable();
    remapBtn.classList.remove("hidden");
    setStatus(
      fileStatus,
      `取り込み完了：新規${res.added}件を追加${res.dup ? `／重複${res.dup}件は除外` : ""}（合計${acc.transactions.length}件）`,
      "ok"
    );
  } else {
    // 初回 → マッピング設定を表示
    openMapping(guessRoles(lastImport.columns, lastImport.hasHeader));
  }
}

// ヘッダ名から役割を推測（各列は「最も長く一致したキーワード」の役割に割り当てる）
function guessRoles(columns, headerInFirstRow) {
  const roles = { date: null, withdrawal: null, deposit: null, amount: null, balance: null, description: null };
  if (!headerInFirstRow) return roles;
  // 列ごとに最有力の役割を求める（例:「入出金」は"出金"より長い"入出金"が勝つ）
  const colBest = columns.map((name) => {
    let best = null;
    let bestLen = 0;
    for (const role of ROLES) {
      for (const k of GUESS[role.key]) {
        if (name.includes(k) && k.length > bestLen) {
          best = role.key;
          bestLen = k.length;
        }
      }
    }
    return best;
  });
  const used = new Set();
  ROLES.forEach((role) => {
    for (let i = 0; i < columns.length; i++) {
      if (used.has(i)) continue;
      if (colBest[i] === role.key) {
        roles[role.key] = i;
        used.add(i);
        break;
      }
    }
  });
  return roles;
}

// ===== マッピングUI =====
function openMapping(prefillRoles) {
  if (!lastImport) return;
  const { columns, dataRows } = lastImport;
  const sample = dataRows[0] || [];
  mappingFields.innerHTML = "";
  ROLES.forEach((role) => {
    const wrap = document.createElement("div");
    wrap.className = "mapping-field";
    const label = document.createElement("label");
    label.textContent = role.label;
    if (role.required) {
      const req = document.createElement("span");
      req.className = "required";
      req.textContent = "必須";
      label.appendChild(req);
    }
    const sel = document.createElement("select");
    sel.dataset.role = role.key;
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "（なし）";
    sel.appendChild(none);
    columns.forEach((c, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      const ex = (sample[i] || "").toString().slice(0, 14);
      opt.textContent = ex ? `${c}（例: ${ex}）` : c;
      sel.appendChild(opt);
    });
    const pre = prefillRoles ? prefillRoles[role.key] : null;
    sel.value = pre != null ? String(pre) : "";
    wrap.appendChild(label);
    wrap.appendChild(sel);
    mappingFields.appendChild(wrap);
  });
  setStatus(mappingStatus, "", "");
  mappingSection.classList.remove("hidden");
  mappingSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function readMappingRoles() {
  const roles = { date: null, withdrawal: null, deposit: null, amount: null, balance: null, description: null };
  mappingFields.querySelectorAll("select").forEach((sel) => {
    roles[sel.dataset.role] = sel.value === "" ? null : Number(sel.value);
  });
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
  // この口座の列構成と役割を記憶（学習）
  acc.mapping = { hasHeader: lastImport.hasHeader, columns: lastImport.columns.slice(), roles };
  if (!acc.noteColumn) acc.noteColumn = pickNoteColumn(lastImport.columns);
  const res = mergeIntoAccount(acc, lastImport.dataRows, roles);
  saveStore();
  mappingSection.classList.add("hidden");
  remapBtn.classList.remove("hidden");
  renderTable();
  setStatus(
    fileStatus,
    `取り込み完了：新規${res.added}件を追加${res.dup ? `／重複${res.dup}件は除外` : ""}（合計${acc.transactions.length}件）`,
    "ok"
  );
}

// 自分が入力する列の名前を決める（既存列と衝突しないように）
function pickNoteColumn(columns) {
  let name = columns.includes("摘要") ? "メモ" : "摘要";
  let n = 2;
  while (columns.includes(name)) {
    name = (columns.includes("摘要") ? "メモ" : "摘要") + n;
    n++;
  }
  return name;
}

// ===== 重複判定キー =====
function normKey(v) {
  return String(v == null ? "" : v).replace(/[,\s　¥￥円]/g, "").trim();
}

function rowKey(cells, roles) {
  const part = (r) => (r == null ? "" : normKey(cells[r]));
  return [
    part(roles.date),
    part(roles.withdrawal),
    part(roles.deposit),
    part(roles.amount),
    part(roles.balance),
    part(roles.description),
  ].join("");
}

// ===== 口座へ取り込み（重複除外） =====
function mergeIntoAccount(acc, dataRows, roles) {
  const cols = acc.mapping.columns;
  const existing = new Set(acc.transactions.map((t) => rowKey(t.cells, roles)));
  let added = 0;
  let dup = 0;
  dataRows.forEach((row) => {
    const cells = cols.map((_, i) => (row[i] !== undefined ? row[i] : ""));
    const key = rowKey(cells, roles);
    if (existing.has(key)) { dup++; return; }
    existing.add(key);
    acc.transactions.push({ cells, note: "" });
    added++;
  });
  return { added, dup };
}

// ===== テーブル描画（保存済み明細） =====
function renderTable() {
  const acc = getCurrentAccount();
  if (!acc || !acc.mapping || acc.transactions.length === 0) {
    editSection.classList.add("hidden");
    exportSection.classList.add("hidden");
    if (acc) rowSummary.textContent = "";
    return;
  }
  editSection.classList.remove("hidden");
  exportSection.classList.remove("hidden");

  const cols = acc.mapping.columns;
  const noteCol = acc.noteColumn;
  rowSummary.textContent = `保存済み：${acc.transactions.length}件`;

  tableHead.innerHTML = "";
  const headRow = document.createElement("tr");
  cols.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  });
  const thNote = document.createElement("th");
  thNote.textContent = noteCol;
  thNote.classList.add("col-tekiyo");
  headRow.appendChild(thNote);
  const thDel = document.createElement("th");
  headRow.appendChild(thDel);
  tableHead.appendChild(headRow);

  tableBody.innerHTML = "";
  acc.transactions.forEach((tx, rowIndex) => {
    const tr = document.createElement("tr");
    cols.forEach((h, i) => {
      const td = document.createElement("td");
      td.textContent = tx.cells[i] !== undefined ? tx.cells[i] : "";
      tr.appendChild(td);
    });
    const tdNote = document.createElement("td");
    tdNote.classList.add("col-tekiyo");
    tdNote.setAttribute("contenteditable", "true");
    tdNote.textContent = tx.note || "";
    tdNote.addEventListener("input", () => {
      acc.transactions[rowIndex].note = tdNote.textContent;
      saveStore();
    });
    tr.appendChild(tdNote);

    const tdDel = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "del-btn";
    delBtn.textContent = "✕";
    delBtn.title = "この行を削除";
    delBtn.addEventListener("click", () => {
      acc.transactions.splice(rowIndex, 1);
      saveStore();
      renderTable();
    });
    tdDel.appendChild(delBtn);
    tr.appendChild(tdDel);
    tableBody.appendChild(tr);
  });
}

// ===== CSV出力 =====
function escapeField(value) {
  const v = value == null ? "" : String(value);
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function buildCSV(acc) {
  const cols = acc.mapping.columns;
  const noteCol = acc.noteColumn;
  const headers = cols.concat([noteCol]);
  const lines = [headers.map(escapeField).join(",")];
  acc.transactions.forEach((tx) => {
    const row = cols.map((_, i) => escapeField(tx.cells[i]));
    row.push(escapeField(tx.note));
    lines.push(row.join(","));
  });
  return lines.join("\r\n");
}

function exportCSV() {
  const acc = getCurrentAccount();
  if (!acc || !acc.mapping || acc.transactions.length === 0) {
    setStatus(exportStatus, "出力するデータがありません", "error");
    return;
  }
  const csv = buildCSV(acc);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const blob = new Blob([bom, csv], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, ensureExt(exportName.value || "出力.csv", ".csv"));
  setStatus(exportStatus, `出力しました（${acc.transactions.length}件）`, "ok");
}

function ensureExt(name, ext) {
  name = name.trim();
  if (!name.toLowerCase().endsWith(ext)) name += ext;
  return name;
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
      if (!obj || !Array.isArray(obj.accounts)) {
        throw new Error("バックアップファイルの形式が正しくありません");
      }
      const ok = confirm(
        "現在のデータをバックアップの内容で置き換えます。今のデータは消えます。よろしいですか？（必要なら先に「バックアップを保存」してください）"
      );
      if (!ok) return;
      store = obj;
      if (!store.selectedAccountId && store.accounts.length) {
        store.selectedAccountId = store.accounts[0].id;
      }
      saveStore();
      lastImport = null;
      renderAccountSelect();
      loadAccountView();
      setStatus(backupStatus, `復元しました（口座${store.accounts.length}件）`, "ok");
    } catch (err) {
      setStatus(backupStatus, "復元に失敗しました: " + err.message, "error");
    }
  };
  reader.onerror = () => setStatus(backupStatus, "ファイルの読み込みに失敗しました", "error");
  reader.readAsText(file);
}

// ===== イベント登録 =====
accountSelect.addEventListener("change", () => {
  store.selectedAccountId = accountSelect.value;
  saveStore();
  lastImport = null;
  remapBtn.classList.add("hidden");
  loadAccountView();
});
accountNewBtn.addEventListener("click", () => openAccountForm("new"));
accountEditBtn.addEventListener("click", () => openAccountForm("edit"));
accountDeleteBtn.addEventListener("click", deleteAccount);
accountForm.addEventListener("submit", saveAccount);
accountCancelBtn.addEventListener("click", closeAccountForm);

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

exportBtn.addEventListener("click", exportCSV);
backupBtn.addEventListener("click", backupData);
restoreInput.addEventListener("change", (e) => restoreData(e.target.files[0]));

// タブ切替
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
renderAccountSelect();
loadAccountView();
