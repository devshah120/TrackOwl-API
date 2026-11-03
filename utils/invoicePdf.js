import { box, companyHeader, signatureMark, INR, fmtDate, amountInWords } from './pdf.js';

// The customer invoice PDF (models/Invoice.js). Same drawing vocabulary as the
// LR and tax-invoice paperwork in utils/documents.js — ruled boxes on A4 — so a
// customer receiving both sees one house style. Every figure printed here is
// the stored, server-computed total; nothing is recalculated for the page.

const M = 28; // page margin
const W = 595.28 - M * 2; // A4 width less margins
const PAGE_BOTTOM = 800;

const GST_LABEL = { cgst_sgst: 'CGST + SGST', igst: 'IGST', none: 'No GST' };

export const drawInvoice = (doc, invoice, user) => {
  let y = M;
  y = companyHeader(doc, user, M, y, W, { title: 'TAX INVOICE' });

  // GSTIN / PAN strip under the header.
  const idLine = [user.gstNumber && `GSTIN: ${user.gstNumber}`, user.panNumber && `PAN: ${user.panNumber}`]
    .filter(Boolean)
    .join('    ');
  if (idLine) {
    doc.font('Helvetica-Bold').fontSize(8).text(idLine, M, y, { width: W, align: 'center' });
    y = doc.y + 4;
  }

  // --- Invoice meta + bill-to ----------------------------------------------
  const half = W / 2;
  box(doc, M, y, half, 18, 'Invoice No.', invoice.invoiceNumber, { valueFont: 'Helvetica-Bold' });
  box(doc, M + half, y, half / 2, 18, 'Invoice Date', fmtDate(invoice.invoiceDate));
  box(doc, M + half * 1.5, y, half / 2, 18, 'Due Date', fmtDate(invoice.dueDate));
  y += 18;
  box(doc, M, y, half, 18, 'Place of Supply', invoice.placeOfSupply || invoice.billTo?.state || '');
  box(doc, M + half, y, half, 18, 'Reverse Charge', invoice.gst?.reverseCharge ? 'Yes' : 'No');
  y += 18;

  const bt = invoice.billTo || {};
  const billText = [bt.name, bt.address, bt.gstin && `GSTIN: ${bt.gstin}`, bt.contact].filter(Boolean).join('\n');
  box(doc, M, y, W, 62, 'Bill To', billText, { valueSize: 8.5 });
  y += 66;

  // --- Lines ----------------------------------------------------------------
  const cols = [
    { key: 'sn', label: '#', w: 22, align: 'center' },
    { key: 'desc', label: 'Description', w: 250 },
    { key: 'sac', label: 'SAC', w: 50, align: 'center' },
    { key: 'qty', label: 'Qty', w: 40, align: 'right' },
    { key: 'rate', label: 'Rate', w: 87, align: 'right' },
    { key: 'amount', label: 'Amount (₹)', w: W - 22 - 250 - 50 - 40 - 87, align: 'right' }
  ];

  const drawHead = () => {
    let x = M;
    doc.rect(M, y, W, 16).fillAndStroke('#eef2ff', '#000');
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(7.5);
    for (const c of cols) {
      doc.text(c.label.replace('₹', 'Rs'), x + 3, y + 5, { width: c.w - 6, align: c.align || 'left' });
      x += c.w;
    }
    y += 16;
  };
  drawHead();

  (invoice.lines || []).forEach((line, i) => {
    const detail = [
      line.tripNumber && `Trip ${line.tripNumber}`,
      line.vehicleNumber && `Vehicle ${line.vehicleNumber}`,
      line.lrNumber && `LR ${line.lrNumber}`,
      line.route
    ]
      .filter(Boolean)
      .join(' · ');
    const descText = [line.description || line.kind, detail].filter(Boolean).join('\n');
    doc.font('Helvetica').fontSize(8);
    const h = Math.max(18, doc.heightOfString(descText, { width: 244 }) + 8);

    if (y + h > PAGE_BOTTOM - 180) {
      doc.addPage();
      y = M;
      drawHead();
    }

    const cells = {
      sn: String(i + 1),
      desc: descText,
      sac: line.sac || '',
      qty: String(line.quantity ?? 1),
      rate: INR(line.rate),
      amount: INR(line.amount)
    };
    let x = M;
    for (const c of cols) {
      doc.lineWidth(0.5).rect(x, y, c.w, h).stroke();
      doc.font('Helvetica').fontSize(8).fillColor('#000').text(cells[c.key], x + 3, y + 4, { width: c.w - 6, align: c.align || 'left' });
      x += c.w;
    }
    y += h;
  });

  // --- Totals ---------------------------------------------------------------
  const t = invoice.totals || {};
  const rows = [['Subtotal', t.subtotal]];
  if (invoice.discount > 0) rows.push(['Less: Discount', -invoice.discount]);
  rows.push(['Taxable Value', t.taxable]);
  if (invoice.gst?.mode === 'cgst_sgst') {
    rows.push([`CGST @ ${invoice.gst.rate / 2}%`, t.cgst], [`SGST @ ${invoice.gst.rate / 2}%`, t.sgst]);
  } else if (invoice.gst?.mode === 'igst') {
    rows.push([`IGST @ ${invoice.gst.rate}%`, t.igst]);
  }
  if (t.roundOff) rows.push(['Round Off', t.roundOff]);

  const labelW = 150;
  const valW = 100;
  const tx = M + W - labelW - valW;
  let ty = y + 6;
  doc.font('Helvetica').fontSize(8.5);
  for (const [label, value] of rows) {
    doc.text(label, tx, ty, { width: labelW - 6, align: 'right' });
    doc.text(INR(value), tx + labelW, ty, { width: valW - 3, align: 'right' });
    ty += 13;
  }
  doc.lineWidth(0.7).moveTo(tx, ty).lineTo(M + W, ty).stroke();
  ty += 4;
  doc.font('Helvetica-Bold').fontSize(10).text('Invoice Total', tx, ty, { width: labelW - 6, align: 'right' });
  doc.text(`Rs ${INR(t.total)}`, tx + labelW, ty, { width: valW - 3, align: 'right' });
  ty += 16;

  if (t.received > 0 || t.adjusted > 0) {
    doc.font('Helvetica').fontSize(8.5);
    doc.text('Received / adjusted', tx, ty, { width: labelW - 6, align: 'right' });
    doc.text(INR(t.received + t.adjusted), tx + labelW, ty, { width: valW - 3, align: 'right' });
    ty += 13;
    doc.font('Helvetica-Bold').text('Balance Due', tx, ty, { width: labelW - 6, align: 'right' });
    doc.text(INR(t.balance), tx + labelW, ty, { width: valW - 3, align: 'right' });
    ty += 13;
  }

  // Left of the totals: amount in words and the GST note.
  doc.font('Helvetica-Bold').fontSize(7.5).text('Amount in words', M, y + 6, { width: W - labelW - valW - 16 });
  doc.font('Helvetica').fontSize(8).text(amountInWords(t.total), M, doc.y + 1, { width: W - labelW - valW - 16 });
  if (invoice.gst?.reverseCharge && invoice.gst?.mode !== 'none') {
    doc
      .font('Helvetica-Oblique')
      .fontSize(7.5)
      .text(
        `GST of Rs ${INR(t.tax)} (${GST_LABEL[invoice.gst.mode]}) is payable by the recipient under reverse charge and is not included in the total.`,
        M,
        doc.y + 6,
        { width: W - labelW - valW - 16 }
      );
  }

  y = Math.max(ty, doc.y) + 14;
  if (y > PAGE_BOTTOM - 110) {
    doc.addPage();
    y = M;
  }

  // --- Footer: bank, terms, signatory ---------------------------------------
  const b = user.bankDetails || {};
  const bank = [
    b.accountName && `A/c Name: ${b.accountName}`,
    b.accountNumber && `A/c No.: ${b.accountNumber}`,
    b.bankName && `Bank: ${b.bankName}${b.branchName ? `, ${b.branchName}` : ''}`,
    b.ifscCode && `IFSC: ${b.ifscCode}`
  ]
    .filter(Boolean)
    .join('\n');
  const footH = 92;
  box(doc, M, y, W * 0.38, footH, 'Bank Details', bank || '—', { valueSize: 8 });
  box(doc, M + W * 0.38, y, W * 0.32, footH, 'Terms', [invoice.terms, invoice.notes].filter(Boolean).join('\n\n'), { valueSize: 7.5 });
  const sx = M + W * 0.7;
  const sw = W * 0.3;
  box(doc, sx, y, sw, footH, `For ${user.company || ''}`, '');
  signatureMark(doc, user, sx, y + 14, sw, footH - 34);
  doc.font('Helvetica').fontSize(7).text('Authorised Signatory', sx, y + footH - 12, { width: sw, align: 'center' });
};
