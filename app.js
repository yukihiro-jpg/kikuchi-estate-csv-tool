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

// 入出金の分類項目
const CATEGORIES = {
  入金: ["家賃", "ガス代", "預り敷金", "その他"],
  出金: ["預り敷金の返済", "家賃の返金", "ガス代の返金", "その他"],
};
function categoryOptions(dir) {
  if (CATEGORIES[dir]) return CATEGORIES[dir];
  return Array.from(new Set([...CATEGORIES["入金"], ...CATEGORIES["出金"]]));
}

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const accountTabs = $("account-tabs");
const settingsBtn = $("settings-btn");

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

const settingsDrawer = $("settings-drawer");
const settingsOverlay = $("settings-overlay");
const settingsClose = $("settings-close");
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
function displayValue(roles, cells, key) {
  if (key === "description") return descOf(roles, cells);
  const idx = roles[key];
  return idx != null ? String(cells[idx] == null ? "" : cells[idx]) : "";
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
function setLearned(acc, dir, desc, entity, items) {
  const d = String(desc || "").trim();
  if (!d || !dir) return;
  if (!acc.learn) acc.learn = {};
  acc.learn[learnKey(dir, desc)] = {
    entity: entity || "",
    items: items.map((it) => ({ category: it.category, amount: it.amount })),
  };
}

// ===== 口座タブ =====
function renderTabs() {
  accountTabs.innerHTML = "";
  store.accounts.forEach((a) => {
    const b = document.createElement("button");
    b.className = "acc-tab" + (a.id === store.selectedAccountId && formMode !== "new" ? " active" : "");
    const label = (a.bankName + (a.accountNumber ? "　" + a.accountNumber : "")).trim() || "(無名の口座)";
    b.textContent = label;
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
  importSection.classList.toggle("hidden", inNew);
  mappingSection.classList.add("hidden");
  remapBtn.classList.toggle("hidden", !(acc && acc.mapping && lastImport));
  if (inNew) {
    editSection.classList.add("hidden");
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
  reader.onload = () => {
    try {
      const text = decodeBytes(reader.result);
      startImport(parseDelimited(text, ","));
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
  return `取り込み完了：新規${res.added}件を追加${res.dup ? `／重複${res.dup}件は除外` : ""}（合計${acc.transactions.length}件）`;
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
  let added = 0, dup = 0;
  dataRows.forEach((row) => {
    const cells = cols.map((_, i) => (row[i] !== undefined ? row[i] : ""));
    const key = rowKey(cells, roles);
    if (existing.has(key)) { dup++; return; }
    existing.add(key);
    const dir = dirOf(roles, cells);
    const learned = getLearned(acc, dir, descOf(roles, cells));
    acc.transactions.push({
      cells,
      entity: learned ? learned.entity : "",
      items: learned ? learned.items.map((it) => ({ category: it.category, amount: it.amount })) : [],
    });
    added++;
  });
  return { added, dup };
}

// ===== テーブル描画 =====
function renderTable() {
  const acc = getCurrentAccount();
  if (!acc || !acc.mapping || acc.transactions.length === 0) {
    editSection.classList.add("hidden");
    if (acc) rowSummary.textContent = "";
    return;
  }
  editSection.classList.remove("hidden");
  const roles = acc.mapping.roles;
  const dcols = displayColumns(roles);
  rowSummary.textContent = `保存済み：${acc.transactions.length}件`;

  // ヘッダ（役割名を使用）
  tableHead.innerHTML = "";
  const headRow = document.createElement("tr");
  dcols.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c.label;
    if (c.num) th.classList.add("num");
    headRow.appendChild(th);
  });
  const thCat = document.createElement("th");
  thCat.textContent = "区分・分類・内訳";
  thCat.classList.add("col-tekiyo");
  headRow.appendChild(thCat);
  headRow.appendChild(document.createElement("th"));
  tableHead.appendChild(headRow);

  // 本体
  tableBody.innerHTML = "";
  acc.transactions.forEach((tx, rowIndex) => {
    if (!tx.items) tx.items = [];
    if (tx.entity == null) tx.entity = "";
    const dir = dirOf(roles, tx.cells);

    const tr = document.createElement("tr");
    dcols.forEach((c) => {
      const td = document.createElement("td");
      td.textContent = displayValue(roles, tx.cells, c.key);
      if (c.num) td.classList.add("num");
      tr.appendChild(td);
    });
    tr.appendChild(buildClassificationCell(acc, tx, rowIndex, dir));

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

// 分類セル：法人/個人の選択と、分類ごとの金額ボックスを常に表示
function getItemAmount(tx, category) {
  const it = (tx.items || []).find((i) => i.category === category);
  return it ? (it.amount == null ? "" : String(it.amount)) : "";
}
function setItemAmount(tx, category, value) {
  if (!tx.items) tx.items = [];
  const idx = tx.items.findIndex((i) => i.category === category);
  if (value === "" || value == null) {
    if (idx >= 0) tx.items.splice(idx, 1);
  } else if (idx >= 0) {
    tx.items[idx].amount = value;
  } else {
    tx.items.push({ category, amount: value });
  }
}

function buildClassificationCell(acc, tx, rowIndex, dir) {
  const td = document.createElement("td");
  td.className = "col-tekiyo col-cat";

  // 区分バッジ ＋ 法人/個人
  const head = document.createElement("div");
  head.className = "cat-head";
  const badge = document.createElement("span");
  badge.className = "dir-badge " + (dir === "入金" ? "dir-in" : dir === "出金" ? "dir-out" : "dir-none");
  badge.textContent = dir || "区分不明";
  head.appendChild(badge);

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
  head.appendChild(entWrap);
  td.appendChild(head);

  if (!dir) {
    const note = document.createElement("div");
    note.className = "empty";
    note.textContent = "入金/出金が判別できないため内訳を入力できません";
    td.appendChild(note);
    return td;
  }

  const totalEl = document.createElement("div");
  totalEl.className = "cat-total";
  function refreshTotal() {
    const itemsTotal = (tx.items || []).reduce((s, it) => s + toNumber(it.amount), 0);
    const amt = amtOf(acc.mapping.roles, tx.cells);
    const diff = amt - itemsTotal;
    totalEl.innerHTML = "";
    totalEl.appendChild(document.createTextNode(`取引 ${yen(amt)}　入力 ${yen(itemsTotal)}　差額 `));
    const span = document.createElement("span");
    span.className = diff === 0 ? "ok" : "ng";
    span.textContent = yen(diff) + (diff === 0 ? "（一致）" : "");
    totalEl.appendChild(span);
  }

  // 分類ごとの金額ボックスを横に並べて常に表示
  const row = document.createElement("div");
  row.className = "cat-row";
  categoryOptions(dir).forEach((cat) => {
    const item = document.createElement("div");
    item.className = "cat-item";
    const name = document.createElement("span");
    name.className = "cat-name";
    name.textContent = cat;
    item.appendChild(name);

    const inp = document.createElement("input");
    inp.type = "text";
    inp.inputMode = "numeric";
    inp.placeholder = "0";
    inp.value = getItemAmount(tx, cat);
    inp.addEventListener("input", () => {
      setItemAmount(tx, cat, inp.value.trim());
      refreshTotal();
      learnFromTx(acc, tx, dir);
      saveStore();
    });
    const field = document.createElement("div");
    field.className = "amount-field";
    const yenMark = document.createElement("span");
    yenMark.className = "yen";
    yenMark.textContent = "¥";
    field.appendChild(yenMark);
    field.appendChild(inp);
    item.appendChild(field);
    row.appendChild(item);
  });
  td.appendChild(row);

  refreshTotal();
  td.appendChild(totalEl);
  return td;
}

function learnFromTx(acc, tx, dir) {
  setLearned(acc, dir, descOf(acc.mapping.roles, tx.cells), tx.entity, tx.items);
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
  const headers = ["銀行名", "口座番号", "日付", "区分", "摘要", "取引金額", "残高", "法人/個人", "分類", "金額"];
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
    const common = [acc.bankName, acc.accountNumber, dateCell, dir, desc, String(amt), bal, tx.entity || ""];
    const items = tx.items && tx.items.length ? tx.items : [{ category: "", amount: "" }];
    items.forEach((it) => {
      const row = common.concat([it.category || "", it.amount === "" || it.amount == null ? "" : String(toNumber(it.amount))]);
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
      saveStore();
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

// ===== イベント登録 =====
function openSettings() {
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
  saveStore();
  setStatus(editStatus, "保存しました（このパソコンのブラウザに記録されました）", "ok");
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
populateRange();
renderAll();
