import nodemailer from 'nodemailer';

let transporter;
let attempted = false;

// SMTP is optional -- until env vars are provided, notifications still get
// created in-portal, email sending is just silently skipped.
export function getMailer() {
  if (attempted) return transporter;
  attempted = true;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
  if (!SMTP_HOST || !SMTP_PORT) {
    transporter = null;
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: SMTP_SECURE === 'true',
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });

  return transporter;
}

export function isMailerConfigured() {
  return Boolean(getMailer());
}

export async function sendMail({ to, subject, text, html }) {
  const mailer = getMailer();
  if (!mailer) {
    const error = new Error('SMTP is not configured');
    error.code = 'SMTP_NOT_CONFIGURED';
    throw error;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@hextorq.tech';
  await mailer.sendMail({ from, to, subject, text, html });
}
