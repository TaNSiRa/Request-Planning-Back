// Professional, role-aware HTML email templates for the Request & Planning system.
//
// Every notification email shares one skeleton — a brand header (section name +
// request no), a coloured status pill, a headline, a greeting, a key/value
// detail card, an attachments list, a deep-link call-to-action, and a footer.
// Only the pill colour and the wording change per role/event, so the mails read
// as one family while still telling each recipient exactly what THEY must do.
//
// Layout is table-based with inline styles so it survives Outlook / MS365, the
// clients this org actually uses. No web fonts, no flexbox, no external assets.

const { query } = require("../db/pool");
const { env } = require("../config/env");

// ---------------------------------------------------------------------------
// Palette (kept in sync with the app design tokens in shared/design.dart)
// ---------------------------------------------------------------------------
const BRAND = "#1f2a63";
const BRAND_2 = "#2c3a86";
const INK = "#161a2e";
const TEXT = "#39405c";
const TEXT_SOFT = "#4a5170";
const MUTED = "#7a8099";
const FAINT = "#9aa0b5";
const PAPER = "#ffffff";
const PAPER_SUB = "#fafbfd";
const CARD_BG = "#fafbfd";
const LINE = "#eef0f6";
const CARD_BORDER = "#e6e8f2";

// Event → accent colours for the status pill.
const ACCENTS = {
  slate: { fg: "#475178", bg: "#eef0f7", bd: "#dee1ee" },
  amber: { fg: "#9a5a0b", bg: "#fdf3e2", bd: "#f2dcae" },
  green: { fg: "#15803d", bg: "#e4f5eb", bd: "#bfe6cd" },
  blue: { fg: "#2f6bed", bg: "#e8effc", bd: "#cfdefa" },
  red: { fg: "#c0322b", bg: "#fdecec", bd: "#f4cccb" },
  hold: { fg: "#8a6240", bg: "#f1ebe3", bd: "#e5d8c8" }
};

const THAI_MONTHS = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."
];

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------
function esc(value) {
  if (value === null || value === undefined) return "";
  return `${value}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Thai Buddhist-era date, e.g. "18 ก.ค. 2569". Date columns are stored as plain
// dates, so read them in UTC to avoid an off-by-one from the server timezone.
function formatThaiDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${THAI_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear() + 543}`;
}

function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Days-remaining hint for a due/period date. Returns "" when not meaningful.
function daysHint(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const diff = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86400000);
  if (diff > 1) return `เหลืออีก ${diff} วัน`;
  if (diff === 1) return "เหลืออีก 1 วัน";
  if (diff === 0) return "ครบกำหนดวันนี้";
  return `เลยกำหนดมา ${Math.abs(diff)} วัน`;
}

const HIGH_PRIORITIES = new Set(["HIGH", "URGENT", "CRITICAL"]);
function priorityChip(priority) {
  const label = esc(priority || "NORMAL");
  const high = HIGH_PRIORITIES.has(`${priority || ""}`.toUpperCase());
  const fg = high ? "#c0322b" : "#475178";
  const bg = high ? "#fdecec" : "#eef0f7";
  return `<span style="display:inline-block;font-size:11.5px;font-weight:700;`
    + `padding:3px 10px;border-radius:6px;color:${fg};background:${bg};">${label}</span>`;
}

// ---------------------------------------------------------------------------
// Deep link — opens the SPA straight onto this request (and the approval inbox
// when view=approval). The frontend reads these query params on boot.
// ---------------------------------------------------------------------------
function buildDeeplink(requestId, view) {
  const base = (env.frontendOrigin || "").replace(/\/+$/, "");
  if (!base || !requestId) return null;
  const params = new URLSearchParams({ request: `${requestId}` });
  if (view) params.set("view", view);
  return `${base}/?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Data loading — one query feeds every template.
// ---------------------------------------------------------------------------
async function loadRequestContext(requestId) {
  const detail = (await query(
    `SELECT r.id, r.request_no, r.title, r.request_type, r.system_area, r.priority,
            r.due_date, r.planned_start, r.planned_end, r.description, r.business_impact, r.status,
            r.requester_user_id, r.incharge_user_id, r.support_user_id,
            requester.display_name AS requester_name,
            requester.branch AS requester_branch, requester.department AS requester_department,
            requester.section AS requester_section,
            inc.display_name AS incharge_name, sup.display_name AS support_name,
            s.name AS section_name
     FROM requests r
     JOIN users requester ON requester.id = r.requester_user_id
     LEFT JOIN users inc ON inc.id = r.incharge_user_id
     LEFT JOIN users sup ON sup.id = r.support_user_id
     JOIN request_sections s ON s.id = r.section_id
     WHERE r.id=@requestId`,
    { requestId }
  )).recordset[0];
  if (!detail) return null;
  detail.attachments = await loadAttachments(requestId);
  return detail;
}

async function loadAttachments(requestId) {
  try {
    const result = await query(
      `SELECT file_name AS fileName, content_type AS contentType, file_size AS fileSize
       FROM request_attachments WHERE request_id=@requestId ORDER BY id`,
      { requestId }
    );
    return result.recordset;
  } catch (err) {
    if (`${err.message}`.includes("Invalid object name")) return [];
    throw err;
  }
}

// Position of the currently-pending step within the main (pre-close) route.
// Returns { position, total } or null when it can't be determined.
async function getApprovalProgress(requestId) {
  try {
    const rows = (await query(
      `SELECT sequence_no, status FROM approval_steps
       WHERE request_id=@requestId AND sequence_no < 100 ORDER BY sequence_no`,
      { requestId }
    )).recordset;
    if (!rows.length) return null;
    const idx = rows.findIndex(r => r.status === "PENDING");
    if (idx < 0) return { position: rows.length, total: rows.length };
    return { position: idx + 1, total: rows.length };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rendering primitives
// ---------------------------------------------------------------------------
function pill(accent, text) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">`
    + `<tr><td style="background:${accent.bg};border:1px solid ${accent.bd};border-radius:20px;`
    + `padding:6px 13px;font-size:12px;font-weight:700;color:${accent.fg};font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">`
    + `${esc(text)}</td></tr></table>`;
}

function kvRow(label, valueHtml) {
  if (valueHtml === null || valueHtml === undefined || valueHtml === "") return "";
  return `<tr>`
    + `<td style="padding:11px 16px;font-size:12.5px;color:${MUTED};background:#f6f7fb;`
    + `border-top:1px solid ${LINE};border-right:1px solid ${LINE};font-weight:600;width:42%;vertical-align:top;font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">${esc(label)}</td>`
    + `<td style="padding:11px 16px;font-size:13.5px;color:${TEXT};border-top:1px solid ${LINE};line-height:1.5;vertical-align:top;font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">${valueHtml}</td>`
    + `</tr>`;
}

function detailCard(cardLabel, title, rowsHtml) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" `
    + `style="border:1px solid ${CARD_BORDER};border-radius:12px;background:${CARD_BG};margin:0 0 22px;">`
    + `<tr><td style="padding:13px 16px 2px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;`
    + `color:${MUTED};font-weight:700;font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">${esc(cardLabel)}</td></tr>`
    + `<tr><td style="padding:2px 16px 12px;font-size:16px;font-weight:700;color:${INK};line-height:1.35;`
    + `font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">${esc(title)}</td></tr>`
    + `<tr><td style="padding:0 8px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" `
    + `style="border:1px solid ${LINE};border-radius:9px;overflow:hidden;background:${PAPER};">${rowsHtml}</table></td></tr>`
    + `</table>`;
}

function sectionTitle(text) {
  return `<p style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};`
    + `font-weight:700;margin:0 0 8px;font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">${esc(text)}</p>`;
}

function descBlock(text) {
  if (!text) return "";
  return sectionTitle("รายละเอียดงาน")
    + `<div style="font-size:13.5px;color:${TEXT_SOFT};line-height:1.7;margin:0 0 22px;padding:14px 16px;`
    + `background:${PAPER_SUB};border:1px solid ${LINE};border-radius:10px;`
    + `font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;white-space:pre-wrap;">${esc(text)}</div>`;
}

function attachmentsBlock(attachments) {
  if (!attachments || !attachments.length) return "";
  const rows = attachments.map(a => {
    const ext = `${a.fileName || ""}`.split(".").pop().toUpperCase().slice(0, 4) || "FILE";
    const size = formatFileSize(a.fileSize);
    return `<tr><td style="padding:0 0 8px;">`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" `
      + `style="border:1px solid ${CARD_BORDER};border-radius:10px;background:${PAPER};">`
      + `<tr>`
      + `<td width="44" style="padding:11px 0 11px 12px;vertical-align:middle;">`
      + `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`
      + `<td style="width:30px;height:30px;background:${BRAND};border-radius:7px;color:#fff;font-size:9px;`
      + `font-weight:800;text-align:center;font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">${esc(ext)}</td>`
      + `</tr></table></td>`
      + `<td style="padding:11px 14px;vertical-align:middle;font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">`
      + `<span style="font-size:13px;color:${INK};font-weight:600;">${esc(a.fileName)}</span>`
      + (size ? `<span style="font-size:11.5px;color:${FAINT};display:block;">${esc(size)}</span>` : "")
      + `</td></tr></table></td></tr>`;
  }).join("");
  return sectionTitle(`เอกสารแนบ · ${attachments.length} ไฟล์`)
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;">${rows}</table>`;
}

// Bulletproof-ish button (table cell anchor) with solid brand/semantic colour.
function button(label, url, bg) {
  if (!url) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 8px 10px 0;display:inline-block;">`
    + `<tr><td style="background:${bg};border-radius:9px;">`
    + `<a href="${esc(url)}" target="_blank" style="display:inline-block;padding:13px 26px;font-size:14px;`
    + `font-weight:700;color:#ffffff;text-decoration:none;font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">${esc(label)}</a>`
    + `</td></tr></table>`;
}

function ghostButton(label, url) {
  if (!url) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 8px 10px 0;display:inline-block;">`
    + `<tr><td style="background:#ffffff;border:1.5px solid ${CARD_BORDER};border-radius:9px;">`
    + `<a href="${esc(url)}" target="_blank" style="display:inline-block;padding:11px 22px;font-size:14px;`
    + `font-weight:700;color:${BRAND};text-decoration:none;font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">${esc(label)}</a>`
    + `</td></tr></table>`;
}

// ---------------------------------------------------------------------------
// Full email shell
// ---------------------------------------------------------------------------
function renderEmail(opts) {
  const {
    sectionName, requestNo, accent, pillText, headline, greetingName,
    paragraphs = [], detailRows = "", detailTitle, description,
    attachments = [], primary, secondary, footerNote
  } = opts;

  const initial = esc(`${sectionName || "R"}`.trim().charAt(0).toUpperCase() || "R");
  const sentAt = formatThaiDate(new Date());
  const paras = paragraphs.map(p =>
    `<p style="font-size:14px;color:${TEXT_SOFT};line-height:1.68;margin:0 0 14px;`
    + `font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">${p}</p>`).join("");

  const cta = (primary || secondary)
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px;"><tr><td>`
    + (primary ? button(primary.label, primary.url, primary.bg || BRAND) : "")
    + (secondary ? ghostButton(secondary.label, secondary.url) : "")
    + `</td></tr></table>`
    + (primary && primary.url
      ? `<p style="font-size:12px;color:${FAINT};line-height:1.6;margin:12px 0 4px;`
      + `font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">หากปุ่มกดไม่ได้ ให้คัดลอกลิงก์นี้เปิดในเบราว์เซอร์:<br>`
      + `<a href="${esc(primary.url)}" target="_blank" style="color:#2f6bed;word-break:break-all;">${esc(primary.url)}</a></p>`
      : "")
    : "";

  return `<!DOCTYPE html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
</head>
<body style="margin:0;padding:0;background:#eceef6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eceef6;">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:${PAPER};border:1px solid ${CARD_BORDER};border-radius:14px;overflow:hidden;">

<!-- header band -->
<tr><td style="background:${BRAND};background:linear-gradient(135deg,${BRAND},${BRAND_2});padding:20px 30px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="vertical-align:middle;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="width:34px;height:34px;background:rgba(255,255,255,.15);border-radius:9px;color:#fff;`
    + `font-size:15px;font-weight:800;text-align:center;font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">${initial}</td>
        <td style="padding-left:11px;font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">
          <div style="font-size:14.5px;font-weight:700;color:#ffffff;line-height:1.2;">${esc(sectionName)}</div>
          <div style="font-size:11.5px;color:rgba(255,255,255,.72);">Request &amp; Planning System</div>
        </td>
      </tr></table>
    </td>
    <td align="right" style="vertical-align:middle;font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">
      <span style="font-size:12px;font-weight:600;color:#ffffff;background:rgba(255,255,255,.13);`
    + `border:1px solid rgba(255,255,255,.22);padding:6px 11px;border-radius:20px;white-space:nowrap;">${esc(requestNo)}</span>
    </td>
  </tr></table>
</td></tr>

<!-- body -->
<tr><td style="padding:28px 30px 6px;">
  ${pill(accent, pillText)}
  <h1 style="font-size:21px;line-height:1.25;margin:0 0 12px;color:${INK};font-weight:700;`
    + `font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">${esc(headline)}</h1>`
    + (greetingName
      ? `<p style="font-size:14px;color:${TEXT};line-height:1.6;margin:0 0 14px;font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">เรียน <strong style="color:${INK};">คุณ ${esc(greetingName)}</strong></p>`
      : "")
    + `${paras}
  ${detailTitle ? detailCard("รายละเอียดคำขอ", detailTitle, detailRows) : ""}
  ${descBlock(description)}
  ${attachmentsBlock(attachments)}
  ${cta}
</td></tr>

<!-- footer -->
<tr><td style="padding:8px 30px 26px;">
  <div style="border-top:1px solid ${LINE};margin:16px 0;"></div>
  <p style="font-size:11.5px;color:${MUTED};font-weight:600;margin:0 0 4px;font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">${esc(sectionName)} · Request &amp; Planning System</p>
  <p style="font-size:11.5px;color:${FAINT};line-height:1.6;margin:0;font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;">`
    + `${footerNote ? esc(footerNote) + " · " : ""}อีเมลฉบับนี้ส่งโดยอัตโนมัติ กรุณาอย่าตอบกลับ${sentAt ? " · ส่งเมื่อ " + esc(sentAt) : ""}</p>
</td></tr>

</table>
</td></tr></table>
</body></html>`;
}

// Plain-text fallback so the mail is never blank in text-only clients.
function renderText(opts) {
  const lines = [
    `${opts.sectionName} · Request & Planning System`,
    `${opts.requestNo}`,
    "",
    opts.headline,
    ""
  ];
  if (opts.greetingName) lines.push(`เรียน คุณ${opts.greetingName}`, "");
  for (const p of opts.plainParagraphs || []) lines.push(p, "");
  if (opts.detailTitle) lines.push(`เรื่อง: ${opts.detailTitle}`);
  for (const [k, v] of opts.plainRows || []) if (v) lines.push(`${k}: ${v}`);
  if (opts.description) lines.push("", "รายละเอียดงาน:", opts.description);
  if (opts.attachments && opts.attachments.length) {
    lines.push("", `เอกสารแนบ (${opts.attachments.length}):`);
    for (const a of opts.attachments) lines.push(`- ${a.fileName}`);
  }
  if (opts.primary && opts.primary.url) lines.push("", `${opts.primary.label}: ${opts.primary.url}`);
  return lines.join("\n");
}

// Shared detail rows shown on most templates. `flags` toggles the extra rows
// that only some roles need.
function baseDetailRows(ctx, flags = {}) {
  const requesterOrg = [ctx.requester_branch, ctx.requester_department, ctx.requester_section]
    .filter(Boolean).join(" / ");
  const due = formatThaiDate(ctx.due_date);
  const dueHint = daysHint(ctx.due_date);
  const period = (ctx.planned_start || ctx.planned_end)
    ? `${formatThaiDate(ctx.planned_start) || "-"} – ${formatThaiDate(ctx.planned_end) || "-"}`
    : null;
  let rows = "";
  if (flags.roleLabel) {
    rows += kvRow("บทบาทของคุณ", `<span style="color:${INK};font-weight:600;">${esc(flags.roleLabel)}</span>`);
  }
  rows += kvRow("ประเภทงาน", esc(ctx.request_type));
  rows += kvRow("ระบบ / พื้นที่", esc(ctx.system_area || "-"));
  rows += kvRow("ความสำคัญ", priorityChip(ctx.priority));
  rows += kvRow("ผู้ขอ",
    `<span style="color:${INK};font-weight:600;">${esc(ctx.requester_name)}</span>`
    + (requesterOrg ? `<br><span style="color:${FAINT};font-size:12px;">${esc(requesterOrg)}</span>` : ""));
  if (flags.period && period) rows += kvRow("ช่วงเวลาโครงการ", esc(period));
  if (due) {
    rows += kvRow("กำหนดส่ง", esc(due) + (dueHint ? ` <span style="color:${FAINT};font-size:12px;">· ${esc(dueHint)}</span>` : ""));
  }
  if (flags.impact && ctx.business_impact) rows += kvRow("ผลกระทบทางธุรกิจ", esc(ctx.business_impact));
  return rows;
}

function plainRowsOf(ctx, flags = {}) {
  const rows = [];
  if (flags.roleLabel) rows.push(["บทบาทของคุณ", flags.roleLabel]);
  rows.push(["ประเภทงาน", ctx.request_type]);
  rows.push(["ความสำคัญ", ctx.priority]);
  rows.push(["ผู้ขอ", ctx.requester_name]);
  const due = formatThaiDate(ctx.due_date);
  if (due) rows.push(["กำหนดส่ง", due]);
  return rows;
}

// ---------------------------------------------------------------------------
// Scenario builders — each returns { subject, html, text, type }
// ---------------------------------------------------------------------------

// 1) Requester's confirmation when a request is submitted.
async function buildRequesterCreatedEmail(requestId) {
  const ctx = await loadRequestContext(requestId);
  if (!ctx) return null;
  const accent = ACCENTS.slate;
  const paragraphs = [
    `คำขอของคุณถูกส่งไปยังแผนก <strong>${esc(ctx.section_name)}</strong> เรียบร้อยแล้ว และกำลังรอการพิจารณาอนุมัติ `
    + `เราจะแจ้งให้คุณทราบทุกครั้งที่สถานะมีการเปลี่ยนแปลง คุณสามารถติดตามความคืบหน้าได้ตลอดเวลาผ่านปุ่มด้านล่าง`
  ];
  const opts = {
    sectionName: ctx.section_name,
    requestNo: ctx.request_no,
    accent,
    pillText: "ส่งคำขอเรียบร้อย · รอการอนุมัติ",
    headline: "เราได้รับคำขอของคุณแล้ว",
    greetingName: ctx.requester_name,
    paragraphs,
    detailTitle: ctx.title,
    detailRows: baseDetailRows(ctx),
    description: ctx.description,
    attachments: ctx.attachments,
    primary: { label: "ดูคำขอของฉัน →", url: buildDeeplink(ctx.id) },
    footerNote: "คุณได้รับอีเมลนี้เพราะเป็นผู้สร้างคำขอ"
  };
  return {
    subject: `✅ ส่งคำขอ ${ctx.request_no} ถึงแผนก ${ctx.section_name} แล้ว`,
    html: renderEmail(opts),
    text: renderText({ ...opts, plainParagraphs: ["คำขอของคุณถูกส่งไปยังแผนก " + ctx.section_name + " แล้ว และกำลังรอการอนุมัติ"], plainRows: plainRowsOf(ctx) }),
    type: "CREATE"
  };
}

// 2) Approver's "action required" mail. kind: "REQUEST" | "CLOSE" | "EXTENSION"
async function buildApproverEmail(requestId, { greetingName, kind = "REQUEST" } = {}) {
  const ctx = await loadRequestContext(requestId);
  if (!ctx) return null;
  const accent = ACCENTS.amber;
  let pillText = "ต้องดำเนินการ · รอการอนุมัติของคุณ";
  let headline = "มีคำขอรอการอนุมัติจากคุณ";
  let subject = `🔔 รอคุณอนุมัติ · คำขอ ${ctx.request_no} จาก ${ctx.requester_name}`;
  let intro = `<strong>${esc(ctx.requester_name)}</strong> ได้ส่งคำขอเข้ามายังแผนก <strong>${esc(ctx.section_name)}</strong> `
    + `และขณะนี้อยู่ในขั้นตอน <strong>“รออนุมัติจากคุณ”</strong>`;

  if (kind === "REQUEST") {
    const progress = await getApprovalProgress(requestId);
    if (progress && progress.total > 1) intro += ` (ลำดับที่ ${progress.position} จาก ${progress.total})`;
  } else if (kind === "CLOSE") {
    pillText = "ต้องดำเนินการ · รออนุมัติปิดงาน";
    headline = "มีงานเสร็จรอการอนุมัติปิด";
    subject = `🔔 รอคุณอนุมัติปิดงาน · ${ctx.request_no}`;
    intro = `งานของคำขอ <strong>${esc(ctx.request_no)}</strong> ถูกส่งว่าดำเนินการเสร็จแล้ว `
      + `กรุณาตรวจสอบและอนุมัติเพื่อปิดคำขอ`;
  } else if (kind === "EXTENSION") {
    pillText = "ต้องดำเนินการ · รออนุมัติขอขยายเวลา";
    headline = "มีคำขอขยายเวลาโครงการรออนุมัติ";
    subject = `🔔 รอคุณอนุมัติขอขยายเวลา · ${ctx.request_no}`;
    intro = `มีการยื่นขอขยายเวลาโครงการของคำขอ <strong>${esc(ctx.request_no)}</strong> กรุณาตรวจสอบและพิจารณาอนุมัติ`;
  }

  const opts = {
    sectionName: ctx.section_name,
    requestNo: ctx.request_no,
    accent,
    pillText,
    headline,
    greetingName,
    paragraphs: [intro + ` กรุณาตรวจสอบรายละเอียดด้านล่างและดำเนินการอนุมัติหรือปฏิเสธ`],
    detailTitle: ctx.title,
    detailRows: baseDetailRows(ctx, { impact: true, period: true }),
    description: ctx.description,
    attachments: ctx.attachments,
    primary: { label: "ตรวจสอบ & อนุมัติ →", url: buildDeeplink(ctx.id, "approval"), bg: "#15803d" },
    secondary: { label: "ดูรายละเอียด", url: buildDeeplink(ctx.id) },
    footerNote: "คุณได้รับอีเมลนี้เพราะเป็นผู้อนุมัติในขั้นตอนนี้"
  };
  return {
    subject,
    html: renderEmail(opts),
    text: renderText({ ...opts, plainParagraphs: ["มีคำขอรอการอนุมัติจากคุณ กรุณาเข้าระบบเพื่อตรวจสอบ"], plainRows: plainRowsOf(ctx, { impact: true }) }),
    type: kind === "CLOSE" ? "CLOSE" : kind === "EXTENSION" ? "EXTENSION" : "APPROVAL"
  };
}

// 3) Assignee (incharge / support) — you have been given the work.
async function buildAssigneeEmail(requestId, { greetingName, roleLabel, assignedByName } = {}) {
  const ctx = await loadRequestContext(requestId);
  if (!ctx) return null;
  const accent = ACCENTS.blue;
  const by = assignedByName ? `<strong>คุณ${esc(assignedByName)}</strong> ได้` : "ผู้อนุมัติได้";
  const opts = {
    sectionName: ctx.section_name,
    requestNo: ctx.request_no,
    accent,
    pillText: "มอบหมายให้คุณ · เริ่มดำเนินการได้",
    headline: "คุณได้รับมอบหมายงานใหม่",
    greetingName,
    paragraphs: [
      `คำขอนี้ได้รับการอนุมัติแล้ว และ${by}มอบหมายให้คุณเป็น <strong>${esc(roleLabel || "ผู้รับผิดชอบงาน")}</strong> `
      + `กรุณาเปิดงานเพื่อดูรายละเอียด วางแผนงานย่อย (To-do) และเริ่มดำเนินการภายในกรอบเวลาที่กำหนด`
    ],
    detailTitle: ctx.title,
    detailRows: baseDetailRows(ctx, { roleLabel, period: true }),
    description: ctx.description,
    attachments: ctx.attachments,
    primary: { label: "เปิดงานของฉัน →", url: buildDeeplink(ctx.id) },
    footerNote: "คุณได้รับอีเมลนี้เพราะถูกมอบหมายให้รับผิดชอบคำขอนี้"
  };
  return {
    subject: `📋 คุณได้รับมอบหมายงานใหม่ · ${ctx.request_no}`,
    html: renderEmail(opts),
    text: renderText({ ...opts, plainParagraphs: ["คุณได้รับมอบหมายงานใหม่ กรุณาเข้าระบบเพื่อดูรายละเอียด"], plainRows: plainRowsOf(ctx, { roleLabel }) }),
    type: "ASSIGN"
  };
}

// 4) Status update to participants. event: APPROVED | REJECTED | COMPLETED |
//    CLOSE_REJECTED | EXTENSION | HOLD
async function buildStatusEmail(requestId, { event, greetingName, comment } = {}) {
  const ctx = await loadRequestContext(requestId);
  if (!ctx) return null;

  const MAP = {
    APPROVED: {
      accent: ACCENTS.green, pill: "อนุมัติแล้ว · กำลังดำเนินการ",
      headline: "คำขอได้รับการอนุมัติแล้ว",
      subject: `✅ อนุมัติแล้ว · ${ctx.request_no} เริ่มดำเนินการ`,
      body: `คำขอ <strong>${esc(ctx.request_no)}</strong> ได้รับการอนุมัติครบทุกขั้นตอนแล้ว และเข้าสู่สถานะ “กำลังดำเนินการ”`,
      type: "APPROVE"
    },
    REJECTED: {
      accent: ACCENTS.red, pill: "ไม่ได้รับการอนุมัติ",
      headline: "คำขอไม่ได้รับการอนุมัติ",
      subject: `⚠️ คำขอ ${ctx.request_no} ไม่ได้รับการอนุมัติ`,
      body: `คำขอ <strong>${esc(ctx.request_no)}</strong> ไม่ได้รับการอนุมัติ`,
      type: "REJECT"
    },
    COMPLETED: {
      accent: ACCENTS.green, pill: "เสร็จสมบูรณ์ · ปิดคำขอแล้ว",
      headline: "งานเสร็จสมบูรณ์และปิดคำขอแล้ว",
      subject: `🎉 งานเสร็จสมบูรณ์ · ปิดคำขอ ${ctx.request_no} แล้ว`,
      body: `งานของคำขอ <strong>${esc(ctx.request_no)}</strong> ได้รับการอนุมัติปิดเรียบร้อยแล้ว ขอบคุณสำหรับความร่วมมือ`,
      type: "COMPLETE"
    },
    CLOSE_REJECTED: {
      accent: ACCENTS.amber, pill: "การปิดงานถูกตีกลับ",
      headline: "การขออนุมัติปิดงานถูกตีกลับ",
      subject: `⚠️ การปิดงาน ${ctx.request_no} ถูกตีกลับ`,
      body: `การขออนุมัติปิดงานของคำขอ <strong>${esc(ctx.request_no)}</strong> ถูกตีกลับ กรุณาตรวจสอบและดำเนินการเพิ่มเติม`,
      type: "REJECT"
    },
    EXTENSION: {
      accent: ACCENTS.blue, pill: "อัปเดตช่วงเวลาโครงการ",
      headline: "ช่วงเวลาโครงการถูกปรับปรุงแล้ว",
      subject: `🗓️ อัปเดตช่วงเวลาโครงการ · ${ctx.request_no}`,
      body: `คำขอขยายเวลาของ <strong>${esc(ctx.request_no)}</strong> ได้รับการอนุมัติ ช่วงเวลาโครงการถูกปรับปรุงเรียบร้อยแล้ว`,
      type: "EXTENSION"
    },
    HOLD: {
      accent: ACCENTS.hold, pill: "พักงานชั่วคราว",
      headline: "คำขอถูกพักงานชั่วคราว",
      subject: `⏸️ คำขอ ${ctx.request_no} ถูกพักงานชั่วคราว`,
      body: `คำขอ <strong>${esc(ctx.request_no)}</strong> ถูกพักงานชั่วคราว (On Hold)`,
      type: "HOLD"
    },
    RESUMED: {
      accent: ACCENTS.blue, pill: "กลับมาดำเนินการต่อ",
      headline: "คำขอกลับมาดำเนินการต่อแล้ว",
      subject: `▶️ คำขอ ${ctx.request_no} กลับมาดำเนินการต่อ`,
      body: `คำขอ <strong>${esc(ctx.request_no)}</strong> ถูกปลดพักงานและกลับเข้าสู่สถานะ “กำลังดำเนินการ” แล้ว`,
      type: "HOLD"
    },
    CANCELLED: {
      accent: ACCENTS.red, pill: "ยกเลิกคำขอ",
      headline: "คำขอถูกยกเลิก",
      subject: `🚫 คำขอ ${ctx.request_no} ถูกยกเลิก`,
      body: `คำขอ <strong>${esc(ctx.request_no)}</strong> ถูกยกเลิกแล้ว`,
      type: "CANCEL"
    },
    WAITING_CLOSE: {
      accent: ACCENTS.slate, pill: "ส่งงาน · รออนุมัติปิด",
      headline: "งานถูกส่งเพื่อรออนุมัติปิด",
      subject: `📤 ส่งงาน ${ctx.request_no} เพื่อรออนุมัติปิดแล้ว`,
      body: `งานของคำขอ <strong>${esc(ctx.request_no)}</strong> ถูกส่งว่าดำเนินการเสร็จ และกำลังรอผู้อนุมัติพิจารณาปิดคำขอ`,
      type: "CLOSE"
    }
  };
  const cfg = MAP[event];
  if (!cfg) return null;

  const paragraphs = [cfg.body];
  if (comment) {
    paragraphs.push(`<span style="color:${MUTED};">หมายเหตุ:</span> ${esc(comment)}`);
  }
  const opts = {
    sectionName: ctx.section_name,
    requestNo: ctx.request_no,
    accent: cfg.accent,
    pillText: cfg.pill,
    headline: cfg.headline,
    greetingName,
    paragraphs,
    detailTitle: ctx.title,
    detailRows: baseDetailRows(ctx, { period: event === "EXTENSION" || event === "APPROVED" }),
    primary: { label: "ดูคำขอ →", url: buildDeeplink(ctx.id) }
  };
  return {
    subject: cfg.subject,
    html: renderEmail(opts),
    text: renderText({ ...opts, plainParagraphs: [cfg.headline], plainRows: plainRowsOf(ctx) }),
    type: cfg.type
  };
}

// Maps the internal notification `type` used by notifyRequestParticipants() to
// the right template, so both route files share one dispatch point.
const PARTICIPANT_EVENTS = {
  APPROVE: "APPROVED",
  REJECT: "REJECTED",
  CLOSE_REJECT: "CLOSE_REJECTED",
  COMPLETE: "COMPLETED",
  EXTENSION: "EXTENSION",
  CANCEL: "CANCELLED",
  WAITING_CLOSE: "WAITING_CLOSE",
  ON_HOLD: "HOLD",
  IN_PROGRESS: "RESUMED"
};

async function buildParticipantEmail(requestId, type, { greetingName, comment, isRequester } = {}) {
  if (type === "CREATE") {
    // Only the requester gets the "we received your request" confirmation.
    if (isRequester === false) return null;
    return buildRequesterCreatedEmail(requestId);
  }
  const event = PARTICIPANT_EVENTS[type];
  if (!event) return null;
  return buildStatusEmail(requestId, { event, greetingName, comment });
}

// ---------------------------------------------------------------------------
// Schedule-extension templates — these ALWAYS spell out the project period both
// BEFORE and AFTER the requested change so the reader can see exactly what moves.
// ---------------------------------------------------------------------------
function periodText(start, end) {
  return `${formatThaiDate(start) || "-"} – ${formatThaiDate(end) || "-"}`;
}

async function loadExtensionContext(extensionId) {
  return (await query(
    `SELECT e.id AS extension_id, e.request_id, e.requested_by,
            e.previous_start, e.previous_end, e.requested_start, e.requested_end, e.reason, e.status,
            rb.display_name AS requested_by_name,
            r.request_no, r.title,
            r.requester_user_id, r.incharge_user_id, r.support_user_id,
            s.name AS section_name
     FROM schedule_extension_requests e
     JOIN requests r ON r.id = e.request_id
     JOIN users rb ON rb.id = e.requested_by
     JOIN request_sections s ON s.id = r.section_id
     WHERE e.id=@extensionId`,
    { extensionId }
  )).recordset[0] || null;
}

function extensionPeriodRows(ctx, newLabel) {
  return kvRow("ผู้ขอเลื่อน", `<span style="color:${INK};font-weight:600;">${esc(ctx.requested_by_name)}</span>`)
    + kvRow("ช่วงเวลาเดิม (ก่อนเปลี่ยน)", esc(periodText(ctx.previous_start, ctx.previous_end)))
    + kvRow(newLabel, `<strong style="color:${INK};">${esc(periodText(ctx.requested_start, ctx.requested_end))}</strong>`)
    + (ctx.reason ? kvRow("เหตุผล", esc(ctx.reason)) : "");
}

// Sent to the approver whose turn it is to review a schedule-extension request.
async function buildExtensionApproverEmail(extensionId, { greetingName } = {}) {
  const ctx = await loadExtensionContext(extensionId);
  if (!ctx) return null;
  const opts = {
    sectionName: ctx.section_name,
    requestNo: ctx.request_no,
    accent: ACCENTS.amber,
    pillText: "ต้องดำเนินการ · รออนุมัติขอเลื่อนเวลา",
    headline: "มีคำขอเลื่อนช่วงเวลาโครงการรออนุมัติ",
    greetingName,
    paragraphs: [
      `<strong>${esc(ctx.requested_by_name)}</strong> ขอเลื่อนช่วงเวลาโครงการของคำขอ <strong>${esc(ctx.request_no)}</strong> `
      + `กรุณาตรวจสอบช่วงเวลาเดิมเทียบกับช่วงเวลาใหม่ด้านล่าง แล้วพิจารณาอนุมัติหรือปฏิเสธ`
    ],
    detailTitle: ctx.title,
    detailRows: extensionPeriodRows(ctx, "ช่วงเวลาใหม่ (ที่ขอเลื่อนเป็น)"),
    primary: { label: "ตรวจสอบ & อนุมัติ →", url: buildDeeplink(ctx.request_id, "approval"), bg: "#15803d" },
    secondary: { label: "ดูรายละเอียด", url: buildDeeplink(ctx.request_id) },
    footerNote: "คุณได้รับอีเมลนี้เพราะเป็นผู้อนุมัติในขั้นตอนนี้"
  };
  return {
    subject: `🔔 รอคุณอนุมัติขอเลื่อนเวลา · ${ctx.request_no}`,
    html: renderEmail(opts),
    text: renderText({
      ...opts,
      plainParagraphs: ["มีคำขอเลื่อนช่วงเวลาโครงการรออนุมัติ"],
      plainRows: [
        ["ช่วงเวลาเดิม", periodText(ctx.previous_start, ctx.previous_end)],
        ["ช่วงเวลาใหม่", periodText(ctx.requested_start, ctx.requested_end)]
      ]
    }),
    type: "EXTENSION"
  };
}

// Sent to the requester + incharge (+ support/requester-of-extension) when a
// schedule extension is approved or rejected. event: "APPROVED" | "REJECTED".
async function buildExtensionResultEmail(extensionId, { event, greetingName, comment } = {}) {
  const ctx = await loadExtensionContext(extensionId);
  if (!ctx) return null;
  const approved = event === "APPROVED";
  const paragraphs = [
    approved
      ? `คำขอเลื่อนช่วงเวลาโครงการของ <strong>${esc(ctx.request_no)}</strong> ได้รับการอนุมัติแล้ว ช่วงเวลาโครงการถูกปรับปรุงตามด้านล่างเรียบร้อย`
      : `คำขอเลื่อนช่วงเวลาโครงการของ <strong>${esc(ctx.request_no)}</strong> ไม่ได้รับการอนุมัติ ช่วงเวลาโครงการยังคงเป็นช่วงเวลาเดิม`
  ];
  if (comment) paragraphs.push(`<span style="color:${MUTED};">หมายเหตุ:</span> ${esc(comment)}`);
  const opts = {
    sectionName: ctx.section_name,
    requestNo: ctx.request_no,
    accent: approved ? ACCENTS.blue : ACCENTS.amber,
    pillText: approved ? "อัปเดตช่วงเวลาโครงการแล้ว" : "คำขอเลื่อนเวลาถูกปฏิเสธ",
    headline: approved ? "อนุมัติเลื่อนช่วงเวลาโครงการแล้ว" : "คำขอเลื่อนช่วงเวลาโครงการถูกปฏิเสธ",
    greetingName,
    paragraphs,
    detailTitle: ctx.title,
    detailRows: extensionPeriodRows(ctx, approved ? "ช่วงเวลาใหม่ (มีผลแล้ว)" : "ช่วงเวลาที่ขอเลื่อนเป็น"),
    primary: { label: "ดูคำขอ →", url: buildDeeplink(ctx.request_id) }
  };
  return {
    subject: approved
      ? `🗓️ อัปเดตช่วงเวลาโครงการ · ${ctx.request_no}`
      : `⚠️ คำขอเลื่อนเวลาถูกปฏิเสธ · ${ctx.request_no}`,
    html: renderEmail(opts),
    text: renderText({
      ...opts,
      plainParagraphs: [approved ? "อนุมัติเลื่อนช่วงเวลาโครงการแล้ว" : "คำขอเลื่อนช่วงเวลาโครงการถูกปฏิเสธ"],
      plainRows: [
        ["ช่วงเวลาเดิม", periodText(ctx.previous_start, ctx.previous_end)],
        ["ช่วงเวลาใหม่", periodText(ctx.requested_start, ctx.requested_end)]
      ]
    }),
    type: "EXTENSION"
  };
}

module.exports = {
  buildDeeplink,
  loadRequestContext,
  buildRequesterCreatedEmail,
  buildApproverEmail,
  buildAssigneeEmail,
  buildStatusEmail,
  buildParticipantEmail,
  buildExtensionApproverEmail,
  buildExtensionResultEmail
};
