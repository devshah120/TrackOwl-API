import PDFDocument from 'pdfkit';

// Shared drawing helpers for the generated documents. The layouts are built
// from absolute-positioned boxes rather than flowing text so the output lines
// up with the pre-printed stationery the office already uses.

export const INR = (n) =>
  Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtDate = (d) => {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB'); // dd/mm/yyyy — what the forms use
};

// Rupees-in-words for the invoice's "Amount in words" line. Indian numbering
// (lakh/crore), which toLocaleString cannot spell out.
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const below100 = (n) =>
  n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`;

const below1000 = (n) =>
  n < 100 ? below100(n)
    : `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' + below100(n % 100) : ''}`;

export const amountInWords = (amount) => {
  const rupees = Math.floor(Math.abs(Number(amount) || 0));
  const paise = Math.round((Math.abs(Number(amount) || 0) - rupees) * 100);
  if (rupees === 0 && paise === 0) return 'Zero Rupees Only';

  const parts = [];
  const push = (value, label) => { if (value) parts.push(`${below1000(value)} ${label}`); };

  push(Math.floor(rupees / 10000000), 'Crore');
  push(Math.floor((rupees % 10000000) / 100000), 'Lakh');
  push(Math.floor((rupees % 100000) / 1000), 'Thousand');
  const last = rupees % 1000;
  if (last) parts.push(below1000(last));

  let words = parts.join(' ') + ' Rupees';
  if (paise) words += ` and ${below100(paise)} Paise`;
  return words + ' Only';
};

// A rectangle with an optional small caption in the top-left and a value
// underneath — the repeating unit of both forms.
export const box = (doc, x, y, w, h, label, value, opts = {}) => {
  const { valueSize = 9, labelSize = 6, align = 'left', valueFont = 'Helvetica' } = opts;
  doc.lineWidth(0.7).rect(x, y, w, h).stroke();

  let textTop = y + 3;
  if (label) {
    doc.font('Helvetica').fontSize(labelSize).fillColor('#333')
      .text(label.toUpperCase(), x + 3, textTop, { width: w - 6, align: 'left' });
    textTop += labelSize + 2;
  }
  if (value !== undefined && value !== null && value !== '') {
    doc.font(valueFont).fontSize(valueSize).fillColor('#000')
      .text(String(value), x + 3, textTop, {
        width: w - 6,
        height: Math.max(h - (textTop - y) - 2, valueSize),
        align,
        ellipsis: true
      });
  }
  doc.fillColor('#000');
};

// Small square that gets a tick when `checked` — the GST-payable-by block.
export const tickBox = (doc, x, y, size, checked) => {
  doc.lineWidth(0.7).rect(x, y, size, size).stroke();
  if (checked) {
    doc.font('Helvetica-Bold').fontSize(size - 1).text('X', x + 1.5, y + 1.5, {
      width: size, lineBreak: false
    });
  }
};

// Transporter header shared by every document, drawn from the user's profile
// so each client's own company details appear.
export const companyHeader = (doc, user, x, y, w, { title = '', subjectTo = '' } = {}) => {
  if (subjectTo) {
    doc.font('Helvetica').fontSize(7).fillColor('#333')
      .text(subjectTo, x, y, { width: w, align: 'center' });
  }

  const nameY = subjectTo ? y + 9 : y;
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#1a3a8f')
    .text(user.company || 'Transport Company', x, nameY, { width: w, align: 'center' });

  if (title) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#1a3a8f')
      .text(title, x, doc.y + 1, { width: w, align: 'center' });
  }

  const lines = [];
  if (user.address || user.city) lines.push([user.address, user.city].filter(Boolean).join(', '));
  const contact = [];
  if (user.mobile) contact.push(`Ph.: ${user.mobile}`);
  if (user.email) contact.push(user.email);
  if (contact.length) lines.push(contact.join('  |  '));

  doc.font('Helvetica').fontSize(7.5).fillColor('#000');
  lines.forEach((line) => {
    doc.text(line, x, doc.y + 1.5, { width: w, align: 'center' });
  });

  return doc.y + 4;
};

// Streams a document to the HTTP response as an inline-named PDF download.
export const streamPdf = (res, filename, draw) => {
  const doc = new PDFDocument({ size: 'A4', margin: 0 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  draw(doc);
  doc.end();
};
