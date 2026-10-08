const nodemailer = require("nodemailer");
const { env } = require("../config/env");
const { query } = require("../db/pool");
const { isMailEnabledForSection } = require("./settingsService");

function isMailConfigured() {
  return Boolean(env.smtp.host && env.smtp.from);
}

// Lazily-built, reused SMTP transporter (module-level singleton). Pooled so
// consecutive messages reuse one authenticated connection instead of paying the
// TCP + STARTTLS + AUTH handshake to the SMTP host for every single email.
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!isMailConfigured()) return null;
  transporter = nodemailer.createTransport({
    pool: true,
    maxConnections: 2,
    host: env.smtp.host,
    port: env.smtp.port || 587,
    // secure=true only for implicit TLS (port 465). Port 587 uses STARTTLS,
    // which nodemailer negotiates automatically with secure=false + requireTLS.
    secure: env.smtp.secure === true,
    requireTLS: env.smtp.secure !== true,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.password } : undefined,
    // Fail fast instead of hanging a request if the SMTP host is unreachable.
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 20000
  });
  return transporter;
}

// Verifies the SMTP connection + credentials WITHOUT sending an email.
async function verifyMail() {
  if (!isMailConfigured()) return { ok: false, reason: "SMTP host/from is not configured" };
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    // Same reasoning as the holiday DB check: nodemailer's failure text carries
    // the host and the authentication reason. Stable code out, detail to the log.
    // eslint-disable-next-line no-console
    console.error(`[mail] verify failed: ${err.message}`);
    return { ok: false, reason: "SMTP_VERIFY_FAILED" };
  }
}

async function resolveSectionId(requestId, sectionId) {
  if (sectionId || !requestId) return sectionId || null;
  const result = await query("SELECT section_id FROM requests WHERE id=@requestId", { requestId });
  return result.recordset[0]?.section_id || null;
}

// Records the message in the outbox, then delivers it. Delivery runs in the
// background by default: a button click (complete work, extension, approve…)
// must not wait seconds per recipient on the SMTP server. Callers that act on
// the outcome (the settings test send, reminder jobs that stamp only after a
// real delivery) pass waitForDelivery: true.
//
// to / cc take one address or a list. attachments: [{ filename, content:
// Buffer }] go out with the message but are not kept in the outbox.
async function sendMail({ to, cc, attachments, subject, html, text, requestId, type, sectionId, ignoreEnabledFlag = false, waitForDelivery = false }) {
  const toList = [].concat(to || []).filter(Boolean);
  const ccList = [].concat(cc || []).filter(Boolean);
  // The outbox keeps one address column of 255 characters: the recipients
  // joined, trimmed to fit (the full lists go to the SMTP server).
  const recorded = [toList.join(", "), ccList.length ? `cc: ${ccList.join(", ")}` : ""]
    .filter(Boolean).join(" | ").slice(0, 255);
  const resolvedSectionId = await resolveSectionId(requestId, sectionId);
  // 'mail.enabled' is the on/off switch OF THE OWNING SECTION — each section
  // decides for itself whether the system emails its people. When off, we still
  // record the message in the outbox (audit trail) but never deliver it. The
  // "test email" path passes ignoreEnabledFlag so admins can verify SMTP before
  // any section flips its switch on.
  const mailEnabled = ignoreEnabledFlag || (await isMailEnabledForSection(resolvedSectionId));
  const configured = isMailConfigured();
  const status = !mailEnabled ? "disabled" : configured ? "queued" : "pending_config";
  // Always record the message in the outbox first (audit trail), then try to
  // deliver it and update the row with the outcome.
  const insert = await query(
    `INSERT INTO email_outbox (request_id, section_id, mail_type, to_email, subject, body_html, status)
     OUTPUT INSERTED.id
     VALUES (@requestId, @sectionId, @type, @to, @subject, @html, @status)`,
    {
      requestId: requestId || null,
      sectionId: resolvedSectionId,
      type,
      to: recorded,
      subject,
      html,
      status
    }
  );
  const outboxId = insert.recordset[0].id;

  if (!mailEnabled) return { sent: false, reason: "Email is switched off for this section (mail.enabled=false)" };

  const tx = getTransporter();
  if (!tx) return { sent: false, reason: "SMTP config is blank" };

  const delivery = deliver(tx, outboxId, { to: toList, cc: ccList, attachments, subject, html, text });
  if (waitForDelivery) return delivery;
  delivery.catch(err => {
    // eslint-disable-next-line no-console
    console.error(`[mail] background delivery to ${to} failed: ${err.message}`);
  });
  return { sent: false, queued: true };
}

async function deliver(tx, outboxId, { to, cc, attachments, subject, html, text }) {
  try {
    const info = await tx.sendMail({
      from: env.smtp.from,
      to,
      cc: cc && cc.length ? cc : undefined,
      subject,
      html,
      text: text || undefined,
      attachments: attachments && attachments.length ? attachments : undefined
    });
    await query(
      "UPDATE email_outbox SET status='sent', sent_at=DATEADD(HOUR, 7, SYSUTCDATETIME()), error_message=NULL WHERE id=@id",
      { id: outboxId }
    );
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    await query("UPDATE email_outbox SET status='failed', error_message=@error WHERE id=@id", {
      id: outboxId,
      error: `${err.message}`.slice(0, 3000)
    });
    // eslint-disable-next-line no-console
    console.error(`[mail] send failed to ${to}: ${err.message}`);
    // The outbox row above keeps the real message for troubleshooting; the
    // value returned here reaches the Settings page ("send test email"), so it
    // stays a stable code rather than the SMTP server's own text.
    return { sent: false, reason: "MAIL_SEND_FAILED" };
  }
}

module.exports = { sendMail, isMailConfigured, verifyMail };
