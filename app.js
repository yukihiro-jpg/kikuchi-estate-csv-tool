"use strict";

// ----- 状態 -----
let headers = [];      // 列名の配列
let rows = [];         // 各行 = { 列名: 値 } のオブジェクト
let tekiyoKey = "";    // 摘要として扱う列名

const TEKIYO_LABEL = "摘要";

// ----- DOM -----
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const fileStatus = document.getElementById("file-status");
const editSection = document.getElementById("edit-section");
const exportSection = document.getElementById("export-section");
const tableHead = document.querySelector("#data-table thead");
const tableBody = document.querySelector("#data-table tbody");
const exportBtn = document.getElementById("export-btn");
const exportName = document.getElementById("export-name");
const exportStatus = document.getElementById("export-status");

// ----- 文字コード判定付きでファイル読込 -----
function decodeBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  // UTF-8 BOM を除去
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  // まず UTF-8 として厳密に試す。不正バイトがあれば Shift_JIS とみなす
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
      const parsed = parseCSV(text);
      loadData(parsed);
      setStatus(fileStatus, `「${file.name}」を読み込みました（${rows.length}件）`, "ok");
    } catch (err) {
      setStatus(fileStatus, "読み込みに失敗しました: " + err.message, "error");
    }
  };
  reader.onerror = () => setStatus(fileStatus, "ファイルの読み込みに失敗しました", "error");
  reader.readAsArrayBuffer(file);
}

// ----- CSVパーサ（ダブルクォート・改行・カンマ対応） -----
function parseCSV(text) {
  const records = [];
  let field = "";
  let record = [];
  let inQuotes = false;
  // 改行を統一
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        record.push(field); field = "";
      } else if (c === "\n") {
        record.push(field); field = "";
        records.push(record); record = [];
      } else {
        field += c;
      }
    }
  }
  // 最後のフィールド/レコード
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // 完全な空行を除去
  return records.filter(r => r.some(v => v.trim() !== ""));
}

// ----- パース結果を状態に反映 -----
function loadData(records) {
  if (records.length === 0) throw new Error("データが空です");

  headers = records[0].map((h, i) => h.trim() || `列${i + 1}`);

  // 既存の摘要列があれば再利用、無ければ新規追加
  const existing = headers.find(h => h === TEKIYO_LABEL || h.includes("摘要"));
  if (existing) {
    tekiyoKey = existing;
  } else {
    tekiyoKey = TEKIYO_LABEL;
    headers.push(tekiyoKey);
  }

  rows = records.slice(1).map(cols => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cols[i] !== undefined ? cols[i] : ""; });
    return obj;
  });

  renderTable();
  editSection.classList.remove("hidden");
  exportSection.classList.remove("hidden");
}

// ----- テーブル描画 -----
function renderTable() {
  // ヘッダ
  tableHead.innerHTML = "";
  const headRow = document.createElement("tr");
  headers.forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    if (h === tekiyoKey) th.classList.add("col-tekiyo");
    headRow.appendChild(th);
  });
  const thDel = document.createElement("th");
  thDel.textContent = "";
  headRow.appendChild(thDel);
  tableHead.appendChild(headRow);

  // 本体
  tableBody.innerHTML = "";
  rows.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    headers.forEach(h => {
      const td = document.createElement("td");
      td.textContent = row[h] !== undefined ? row[h] : "";
      if (h === tekiyoKey) {
        td.classList.add("col-tekiyo");
        td.setAttribute("contenteditable", "true");
        td.addEventListener("input", () => { rows[rowIndex][h] = td.textContent; });
      }
      tr.appendChild(td);
    });
    const tdDel = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "del-btn";
    delBtn.textContent = "✕";
    delBtn.title = "この行を削除";
    delBtn.addEventListener("click", () => {
      rows.splice(rowIndex, 1);
      renderTable();
    });
    tdDel.appendChild(delBtn);
    tr.appendChild(tdDel);
    tableBody.appendChild(tr);
  });
}

// ----- CSV出力 -----
function escapeField(value) {
  const v = value == null ? "" : String(value);
  if (/[",\n]/.test(v)) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

function buildCSV() {
  const lines = [];
  lines.push(headers.map(escapeField).join(","));
  rows.forEach(row => {
    lines.push(headers.map(h => escapeField(row[h])).join(","));
  });
  return lines.join("\r\n");
}

function exportCSV() {
  if (rows.length === 0) {
    setStatus(exportStatus, "出力するデータがありません", "error");
    return;
  }
  const csv = buildCSV();
  // ExcelでもらえるようUTF-8 BOM付き
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const blob = new Blob([bom, csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  let name = (exportName.value || "出力.csv").trim();
  if (!name.toLowerCase().endsWith(".csv")) name += ".csv";
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setStatus(exportStatus, `「${name}」を出力しました（${rows.length}件）`, "ok");
}

// ----- ユーティリティ -----
function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

// ----- イベント登録 -----
fileInput.addEventListener("change", e => handleFile(e.target.files[0]));

dropzone.addEventListener("dragover", e => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", e => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

exportBtn.addEventListener("click", exportCSV);
