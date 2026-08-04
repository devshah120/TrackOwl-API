import { box, tickBox, companyHeader, INR, fmtDate, amountInWords } from './pdf.js';

// A4 at 72dpi is 595x842pt. An 18pt margin leaves a printable width of 559,
// close to the proportions of the pre-printed LR book.
const M = 18;
const W = 595 - M * 2;

// "40 Boxes" — the packaging count.
const qtyOf = (trip) =>
  trip.goods?.quantity ? `${trip.goods.quantity} ${trip.goods.unit || ''}`.trim() : '';

// "1250 Kg" — a mass, which carries its own unit rather than the packaging one.
const weightOf = (trip) =>
  trip.goods?.weight ? `${trip.goods.weight} ${trip.goods.weightUnit || 'Kg'}`.trim() : '';

// ---------------------------------------------------------------------------
// Lorry Receipt — laid out to match the consignment note the office already
// uses: header, truck/from/consignee band, consignor band, then the goods
// table with the GST block on the left and the freight totals column on the
// right, and the copy-colour legend beneath.
// ---------------------------------------------------------------------------
export const drawLorryReceipt = (doc, trip, user) => {
  const outerTop = M;
  let y = M + 6;

  doc.font('Helvetica').fontSize(7)
    .text('Subject to jurisdiction', M, y, { width: W - 6, align: 'right' });

  y = companyHeader(doc, user, M, y, W, { title: 'TRANSPORT CONTRACTOR & COMMISSION AGENT' });

  // LR number and date sit in their own boxes at the top-right, as on the form.
  const noW = 130;
  box(doc, M + W - noW, outerTop + 6, noW, 26, 'No.', trip.lr || '', { valueSize: 13, valueFont: 'Helvetica-Bold' });
  box(doc, M + W - noW, outerTop + 32, noW, 20, 'Date', fmtDate(trip.date), { valueSize: 9 });

  y = Math.max(y, outerTop + 58);

  // --- Truck / From / To band -------------------------------------------
  const rowH = 26;
  const truckW = 150;
  const fromW = 150;
  box(doc, M, y, truckW, rowH, 'Truck No.', trip.truck);
  box(doc, M + truckW, y, fromW, rowH, 'From', trip.fromLocation);
  box(doc, M + truckW + fromW, y, W - truckW - fromW, rowH, 'To', trip.toLocation);
  y += rowH;

  // --- Consignor / Consignee --------------------------------------------
  const partyH = 46;
  const halfW = W / 2;
  box(doc, M, y, halfW, partyH, 'Consignor',
    [trip.consignor?.name, trip.consignor?.address, trip.consignor?.gst && `GSTIN: ${trip.consignor.gst}`]
      .filter(Boolean).join('\n'), { valueSize: 8 });
  box(doc, M + halfW, y, W - halfW, partyH, 'Consignee',
    [trip.consignee?.name || trip.partyName, trip.consignee?.address, trip.consignee?.gst && `GSTIN: ${trip.consignee.gst}`]
      .filter(Boolean).join('\n'), { valueSize: 8 });
  y += partyH;

  // --- Goods table -------------------------------------------------------
  // Left column carries the GSTIN + tax-payable block, mirroring the form.
  const leftW = 150;
  const artW = 60;
  const freightW = 110;
  const descW = W - leftW - artW - freightW;
  const bodyH = 150;

  // Two-line column headings; drawn directly rather than via box() so the
  // second line is never clipped by the cell height.
  const headH = 22;
  const colHead = (cx, cw, text) => {
    doc.lineWidth(0.7).rect(cx, y, cw, headH).stroke();
    doc.font('Helvetica-Bold').fontSize(6).fillColor('#000')
      .text(text, cx + 2, y + 5, { width: cw - 4, align: 'center', lineGap: 1 });
  };
  colHead(M + leftW, artW, 'No. of\nArticles');
  colHead(M + leftW + artW, descW, "DESCRIPTION OF GOODS\n(as per consignor's intimation)");
  colHead(M + leftW + artW + descW, freightW, 'FREIGHT TO BE PAID\nBY CONSIGNEE');

  // Left GST block spans the header + body height.
  const gstBlockH = headH + bodyH;
  doc.lineWidth(0.7).rect(M, y, leftW, gstBlockH).stroke();
  doc.font('Helvetica-Bold').fontSize(8).text('GSTIN', M + 6, y + 6, { width: leftW - 12 });
  doc.font('Helvetica').fontSize(8).text(user.gstNumber || '—', M + 6, y + 16, { width: leftW - 12 });

  doc.font('Helvetica').fontSize(7).text('GST TAX PAYABLE BY', M + 6, y + 34, { width: leftW - 12 });
  ['Consignor', 'Consignee', 'Transporter'].forEach((who, i) => {
    const ty = y + 48 + i * 18;
    doc.font('Helvetica').fontSize(8).text(who, M + 6, ty + 1, { width: 70 });
    tickBox(doc, M + 92, ty, 11, trip.gstPayableBy === who);
  });

  // Goods body cells.
  box(doc, M + leftW, y + headH, artW, bodyH, '', qtyOf(trip), { valueSize: 9, align: 'center' });

  const descLines = [trip.goods?.description];
  if (trip.goods?.weight) descLines.push(`Weight: ${weightOf(trip)}`);
  if (trip.goods?.declaredValue) descLines.push(`Declared Value: Rs. ${INR(trip.goods.declaredValue)}`);
  box(doc, M + leftW + artW, y + headH, descW, bodyH, '', descLines.filter(Boolean).join('\n'), { valueSize: 9 });

  // Freight totals column: rows down the right edge, as on the printed form.
  const fx = M + leftW + artW + descW;
  const freightRows = [
    ['G.T. 100%', trip.amount],
    ['S. Taxes', null],
    ['L.R. Charges', trip.lrCharges],
    ['H. Charge', null]
  ];
  const fRowH = 26;
  freightRows.forEach(([label, val], i) => {
    const ry = y + headH + i * fRowH;
    doc.lineWidth(0.7).rect(fx, ry, freightW, fRowH).stroke();
    doc.font('Helvetica').fontSize(7).text(label, fx + 4, ry + 5, { width: freightW - 8 });
    if (val) {
      doc.font('Helvetica').fontSize(9)
        .text(INR(val), fx + 4, ry + 14, { width: freightW - 8, align: 'right' });
    }
  });

  const totalY = y + headH + freightRows.length * fRowH;
  const totalH = bodyH - freightRows.length * fRowH;
  doc.lineWidth(0.7).rect(fx, totalY, freightW, totalH).stroke();
  doc.font('Helvetica-Bold').fontSize(8).text('TOTAL', fx + 4, totalY + 4, { width: freightW - 8 });
  doc.font('Helvetica-Bold').fontSize(10)
    .text(INR(Number(trip.amount || 0) + Number(trip.lrCharges || 0)), fx + 4, totalY + 15,
      { width: freightW - 8, align: 'right' });

  y += gstBlockH;

  // --- Copy legend / invoice refs / signature ----------------------------
  const legendH = 74;
  const legendW = 150;
  doc.lineWidth(0.7).rect(M, y, legendW, legendH).stroke();
  const copies = [
    'WHITE   : CONSIGNOR COPY',
    'PINK     : OFFICE COPY',
    'GREEN  : DRIVER COPY',
    'GREEN  : CONSIGNEE COPY',
    'GREEN  : BOOK COPY'
  ];
  copies.forEach((c, i) => {
    doc.font('Helvetica').fontSize(6.5).text(c, M + 5, y + 6 + i * 11, { width: legendW - 10 });
  });

  const midW = W - legendW - freightW;
  doc.lineWidth(0.7).rect(M + legendW, y, midW, legendH).stroke();
  const refs = [
    ['As per Invoice No.', trip.invoiceNo || trip.bill || ''],
    ['Driver', trip.driver?.name || ''],
    ['Consignee Phone No.', trip.consignee?.contact || '']
  ];
  refs.forEach(([label, val], i) => {
    const ry = y + 8 + i * 21;
    doc.font('Helvetica').fontSize(7).text(`${label} :`, M + legendW + 6, ry, { width: 110 });
    doc.font('Helvetica').fontSize(8.5)
      .text(val, M + legendW + 118, ry - 1, { width: midW - 126, ellipsis: true });
  });

  doc.lineWidth(0.7).rect(fx, y, freightW, legendH).stroke();
  doc.font('Helvetica').fontSize(7)
    .text(`For ${user.company || ''}`, fx + 4, y + 6, { width: freightW - 8, align: 'center' });
  doc.font('Helvetica').fontSize(6.5).fillColor('#555')
    .text('Authorised Signatory', fx + 4, y + legendH - 14, { width: freightW - 8, align: 'center' });
  doc.fillColor('#000');
  y += legendH;

  // --- Terms footer ------------------------------------------------------
  const termsH = 34;
  doc.lineWidth(0.7).rect(M, y, W, termsH).stroke();
  doc.font('Helvetica').fontSize(6.5).text(
    '(1) Issued subject to terms & conditions printed overleaf.  (2) Carriers are not responsible for leakage, ' +
    'breakage & damage.  (3) The company is not responsible for loss due to any natural calamities.  ' +
    'AT OWNER\'S RISK — DOOR DELIVERY.',
    M + 5, y + 6, { width: W - 10 }
  );
  y += termsH;

  // Outer frame last, so it sits cleanly over the internal rules.
  doc.lineWidth(1.2).rect(M, outerTop, W, y - outerTop).stroke();
};

// ---------------------------------------------------------------------------
// Tax Invoice — a GST-style freight bill for the same trip.
// ---------------------------------------------------------------------------
export const drawTaxInvoice = (doc, trip, user) => {
  const outerTop = M;
  let y = M + 6;

  y = companyHeader(doc, user, M, y, W, { title: 'TAX INVOICE' });
  y = Math.max(y, outerTop + 62);

  const rowH = 24;
  const third = W / 3;
  box(doc, M, y, third, rowH, 'Invoice No.', trip.invoiceNo || trip.bill || trip.lr || '');
  box(doc, M + third, y, third, rowH, 'Invoice Date', fmtDate(trip.date));
  box(doc, M + third * 2, y, W - third * 2, rowH, 'Truck No.', trip.truck);
  y += rowH;

  const half = W / 2;
  const partyH = 62;
  box(doc, M, y, half, partyH, 'Billed To (Consignee)',
    [trip.consignee?.name || trip.partyName, trip.consignee?.address,
      trip.consignee?.gst && `GSTIN: ${trip.consignee.gst}`,
      trip.consignee?.contact && `Ph: ${trip.consignee.contact}`]
      .filter(Boolean).join('\n'), { valueSize: 8 });
  box(doc, M + half, y, W - half, partyH, 'Consignor',
    [trip.consignor?.name, trip.consignor?.address,
      trip.consignor?.gst && `GSTIN: ${trip.consignor.gst}`]
      .filter(Boolean).join('\n'), { valueSize: 8 });
  y += partyH;

  box(doc, M, y, half, rowH, 'From', trip.fromLocation);
  box(doc, M + half, y, W - half, rowH, 'To', trip.toLocation);
  y += rowH;

  // Line-item table.
  const cols = [
    ['#', 26],
    ['Particulars', W - 26 - 70 - 70 - 100],
    ['Qty', 70],
    ['Rate', 70],
    ['Amount', 100]
  ];
  const headY = y;
  let cx = M;
  cols.forEach(([label, w], i) => {
    doc.lineWidth(0.7).rect(cx, headY, w, 20).stroke();
    doc.font('Helvetica-Bold').fontSize(7.5)
      .text(label, cx + 4, headY + 6, { width: w - 8, align: i >= 2 ? 'right' : 'left' });
    cx += w;
  });
  y += 20;

  const itemH = 22;
  const values = [
    '1',
    ['Freight charges', trip.goods?.description, trip.fromLocation && trip.toLocation
      ? `${trip.fromLocation} to ${trip.toLocation}` : ''].filter(Boolean).join(' — '),
    qtyOf(trip),
    trip.goods?.freightRate ? INR(trip.goods.freightRate) : '',
    INR(trip.amount)
  ];
  cx = M;
  cols.forEach(([, w], i) => {
    doc.lineWidth(0.7).rect(cx, y, w, itemH).stroke();
    doc.font('Helvetica').fontSize(8)
      .text(values[i], cx + 4, y + 7, { width: w - 8, align: i >= 2 ? 'right' : 'left', ellipsis: true });
    cx += w;
  });
  y += itemH;

  // Filler rows keep the table a consistent height regardless of item count.
  const fillerH = 44;
  doc.lineWidth(0.7).rect(M, y, W - 100, fillerH).stroke();
  doc.lineWidth(0.7).rect(M + W - 100, y, 100, fillerH).stroke();
  y += fillerH;

  // Totals: LR charges then grand total.
  const labelW = W - 100 - 120;
  const rows = [
    ['L.R. / Other Charges', INR(trip.lrCharges)],
    ['Advance Received', INR(trip.payment?.advance)],
    ['Balance Payable', INR(trip.payment?.balance)]
  ];
  rows.forEach(([label, val]) => {
    doc.lineWidth(0.7).rect(M + labelW, y, 120, 18).stroke();
    doc.lineWidth(0.7).rect(M + labelW + 120, y, 100, 18).stroke();
    doc.font('Helvetica').fontSize(7.5).text(label, M + labelW + 4, y + 5, { width: 112 });
    doc.font('Helvetica').fontSize(8.5)
      .text(val, M + labelW + 124, y + 5, { width: 92, align: 'right' });
    y += 18;
  });

  const grand = Number(trip.amount || 0) + Number(trip.lrCharges || 0);
  doc.lineWidth(0.7).rect(M + labelW, y, 120, 22).stroke();
  doc.lineWidth(0.7).rect(M + labelW + 120, y, 100, 22).stroke();
  doc.font('Helvetica-Bold').fontSize(9).text('TOTAL', M + labelW + 4, y + 7, { width: 112 });
  doc.font('Helvetica-Bold').fontSize(10)
    .text(INR(grand), M + labelW + 124, y + 6, { width: 92, align: 'right' });

  // Amount in words fills the space left of the totals stack.
  const wordsTop = y - rows.length * 18;
  doc.lineWidth(0.7).rect(M, wordsTop, labelW, rows.length * 18 + 22).stroke();
  doc.font('Helvetica').fontSize(7).text('Amount in words', M + 5, wordsTop + 5, { width: labelW - 10 });
  doc.font('Helvetica-Bold').fontSize(8.5)
    .text(amountInWords(grand), M + 5, wordsTop + 16, { width: labelW - 10 });
  y += 22;

  // Payment status + bank details + signature.
  const footH = 78;
  const bankW = W - 170;
  doc.lineWidth(0.7).rect(M, y, bankW, footH).stroke();
  doc.font('Helvetica-Bold').fontSize(7.5).text('Bank Details', M + 5, y + 5, { width: bankW - 10 });
  const b = user.bankDetails || {};
  const bankLines = [
    b.accountName && `A/c Name: ${b.accountName}`,
    b.bankName && `Bank: ${b.bankName}`,
    b.accountNumber && `A/c No: ${b.accountNumber}`,
    b.ifscCode && `IFSC: ${b.ifscCode}`,
    b.branchName && `Branch: ${b.branchName}`
  ].filter(Boolean);
  doc.font('Helvetica').fontSize(7.5)
    .text(bankLines.length ? bankLines.join('\n') : 'Not configured in Settings',
      M + 5, y + 16, { width: bankW - 10 });

  doc.font('Helvetica').fontSize(7.5)
    .text(`Payment Status: ${trip.status}${trip.payment?.method ? '  |  Mode: ' + trip.payment.method : ''}`,
      M + 5, y + footH - 14, { width: bankW - 10 });

  doc.lineWidth(0.7).rect(M + bankW, y, 170, footH).stroke();
  doc.font('Helvetica').fontSize(7.5)
    .text(`For ${user.company || ''}`, M + bankW + 6, y + 8, { width: 158, align: 'center' });
  doc.font('Helvetica').fontSize(7).fillColor('#555')
    .text('Authorised Signatory', M + bankW + 6, y + footH - 16, { width: 158, align: 'center' });
  doc.fillColor('#000');
  y += footH;

  doc.lineWidth(1.2).rect(M, outerTop, W, y - outerTop).stroke();
};

// ---------------------------------------------------------------------------
// Goods Declaration — the consignor's statement of what is being carried.
// ---------------------------------------------------------------------------
export const drawGoodsDeclaration = (doc, trip, user) => {
  const outerTop = M;
  let y = M + 6;

  y = companyHeader(doc, user, M, y, W, { title: 'GOODS DECLARATION' });
  y = Math.max(y, outerTop + 62);

  const rowH = 24;
  const third = W / 3;
  box(doc, M, y, third, rowH, 'Declaration No.', trip.lr || trip.bill || '');
  box(doc, M + third, y, third, rowH, 'Date', fmtDate(trip.date));
  box(doc, M + third * 2, y, W - third * 2, rowH, 'Truck No.', trip.truck);
  y += rowH;

  const half = W / 2;
  box(doc, M, y, half, rowH, 'From', trip.fromLocation);
  box(doc, M + half, y, W - half, rowH, 'To', trip.toLocation);
  y += rowH;

  const partyH = 58;
  box(doc, M, y, half, partyH, 'Consignor (Declarant)',
    [trip.consignor?.name, trip.consignor?.address,
      trip.consignor?.gst && `GSTIN: ${trip.consignor.gst}`,
      trip.consignor?.contact && `Ph: ${trip.consignor.contact}`]
      .filter(Boolean).join('\n'), { valueSize: 8 });
  box(doc, M + half, y, W - half, partyH, 'Consignee',
    [trip.consignee?.name || trip.partyName, trip.consignee?.address,
      trip.consignee?.gst && `GSTIN: ${trip.consignee.gst}`,
      trip.consignee?.contact && `Ph: ${trip.consignee.contact}`]
      .filter(Boolean).join('\n'), { valueSize: 8 });
  y += partyH;

  // Particulars of the consignment.
  const descH = 56;
  box(doc, M, y, W, descH, 'Description of Goods', trip.goods?.description, { valueSize: 9 });
  y += descH;

  const quarter = W / 4;
  box(doc, M, y, quarter, rowH + 6, 'Quantity', qtyOf(trip));
  box(doc, M + quarter, y, quarter, rowH + 6, 'Total Weight', weightOf(trip));
  box(doc, M + quarter * 2, y, quarter, rowH + 6, 'Declared Value (Rs.)',
    trip.goods?.declaredValue ? INR(trip.goods.declaredValue) : '');
  box(doc, M + quarter * 3, y, W - quarter * 3, rowH + 6, 'Invoice No.',
    trip.invoiceNo || trip.bill || '');
  y += rowH + 6;

  box(doc, M, y, half, rowH + 6, 'Driver',
    [trip.driver?.name, trip.driver?.mobile].filter(Boolean).join(' — '));
  box(doc, M + half, y, W - half, rowH + 6, 'Driver Licence No.', trip.driver?.licenseNumber);
  y += rowH + 6;

  // Declaration text.
  const declH = 76;
  doc.lineWidth(0.7).rect(M, y, W, declH).stroke();
  doc.font('Helvetica-Bold').fontSize(8).text('DECLARATION', M + 6, y + 6, { width: W - 12 });
  doc.font('Helvetica').fontSize(8).text(
    'I/We hereby declare that the particulars of the goods stated above are true and correct to the best of ' +
    'my/our knowledge and belief. The goods tendered for carriage do not include any contraband, hazardous ' +
    'or prohibited articles. The declared value stated above is the true value of the consignment for the ' +
    'purposes of carriage, and the goods are tendered at owner\'s risk.',
    M + 6, y + 18, { width: W - 12, align: 'justify' }
  );
  y += declH;

  // Signature strip.
  const signH = 62;
  const cols = ['Consignor / Declarant', 'Driver', `For ${user.company || ''}`];
  const cw = W / cols.length;
  cols.forEach((label, i) => {
    const cxx = M + i * cw;
    const width = i === cols.length - 1 ? W - cw * i : cw;
    doc.lineWidth(0.7).rect(cxx, y, width, signH).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor('#555')
      .text(label, cxx + 4, y + signH - 16, { width: width - 8, align: 'center' });
  });
  doc.fillColor('#000');
  y += signH;

  doc.lineWidth(1.2).rect(M, outerTop, W, y - outerTop).stroke();
};
