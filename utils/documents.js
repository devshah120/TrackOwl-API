import { box, tickBox, companyHeader, signatureMark, INR, fmtDate, amountInWords } from './pdf.js';

// A4 at 72dpi is 595x842pt. An 18pt margin leaves a printable width of 559,
// close to the proportions of the pre-printed LR book.
const M = 18;
const W = 595 - M * 2;

// "40 Boxes" â€” the packaging count.
const qtyOf = (trip) =>
  trip.goods?.quantity ? `${trip.goods.quantity} ${trip.goods.unit || ''}`.trim() : '';

// "1250 Kg" â€” a mass, which carries its own unit rather than the packaging one.
const weightOf = (trip) =>
  trip.goods?.weight ? `${trip.goods.weight} ${trip.goods.weightUnit || 'Kg'}`.trim() : '';

// ---------------------------------------------------------------------------
// Lorry Receipt â€” laid out to match the consignment note the office already
// uses: header, truck/from/consignee band, consignor band, then the goods
// table with the GST block on the left and the freight totals column on the
// right, and the copy-colour legend beneath.
// ---------------------------------------------------------------------------
export const drawLorryReceipt = (doc, trip, user) => {
  const outerTop = M;
  let y = M + 6;

  doc.font('Helvetica').fontSize(7)
    .text('Subject to jurisdiction', M, y, { width: W - 6, align: 'right' });

  y = companyHeader(doc, user, M, y, W, { title: 'Lorry Receipt (LR)' });

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
  doc.font('Helvetica').fontSize(8).text(user.gstNumber || 'â€”', M + 6, y + 16, { width: leftW - 12 });

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
  // Between the "For <company>" line and the caption, leaving both legible.
  signatureMark(doc, user, fx, y + 16, freightW, legendH - 34);
  const lrSignatory = user.signature?.signatoryName;
  if (lrSignatory) {
    doc.font('Helvetica').fontSize(6.5).fillColor('#000')
      .text(lrSignatory, fx + 4, y + legendH - 22, { width: freightW - 8, align: 'center' });
  }
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
    'AT OWNER\'S RISK â€” DOOR DELIVERY.',
    M + 5, y + 6, { width: W - 10 }
  );
  y += termsH;

  // Outer frame last, so it sits cleanly over the internal rules.
  doc.lineWidth(1.2).rect(M, outerTop, W, y - outerTop).stroke();
};

// ---------------------------------------------------------------------------
// Tax Invoice â€” a GST-style freight bill for the same trip.
// ---------------------------------------------------------------------------
export const drawTaxInvoice = (doc, trip, user) => {
  const outerTop = M;

  // Title sits above the frame, as on the reference form.
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000')
    .text('Tax Invoice', M, outerTop, { width: W, align: 'center' });
  let y = outerTop + 18;
  const frameTop = y;

  // --- Seller / buyer column (left) beside the reference grid (right) -----
  const leftW = Math.round(W * 0.5);
  const rightW = W - leftW;
  const refRowH = 26;

  // Right grid: eleven reference boxes in two columns, the last spanning both.
  const refPairs = [
    ['Invoice No.', trip.invoiceNo || trip.bill || trip.lr || '', 'Dated', fmtDate(trip.date)],
    ['Delivery Note', trip.references?.deliveryNote, 'Mode/Terms of Payment', trip.references?.paymentTerms || trip.payment?.method],
    ["Supplier's Ref.", trip.references?.supplierRef, 'Other Reference(s)', trip.references?.otherRef],
    ["Buyer's Order No.", trip.references?.buyerOrderNo, 'Dated', trip.references?.buyerOrderDate],
    ['Despatch Document No.', trip.references?.despatchDocNo, 'Delivery Note Date', trip.references?.deliveryNoteDate],
    ['Despatched through', trip.references?.despatchedThrough || trip.truck, 'Destination', trip.references?.destination || trip.toLocation]
  ];
  const halfRight = rightW / 2;
  refPairs.forEach(([l1, v1, l2, v2], i) => {
    const ry = y + i * refRowH;
    box(doc, M + leftW, ry, halfRight, refRowH, l1, v1, { valueSize: 8, labelSize: 5.5 });
    box(doc, M + leftW + halfRight, ry, rightW - halfRight, refRowH, l2, v2, { valueSize: 8, labelSize: 5.5 });
  });
  const termsY = y + refPairs.length * refRowH;
  const termsH = 34;
  box(doc, M + leftW, termsY, rightW, termsH, 'Terms of Delivery', trip.references?.termsOfDelivery,
    { valueSize: 8, labelSize: 5.5 });

  const rightBottom = termsY + termsH;

  // Left column: seller block on top, buyer block filling the rest.
  const sellerH = Math.round((rightBottom - y) * 0.42);
  doc.lineWidth(0.7).rect(M, y, leftW, sellerH).stroke();
  doc.font('Helvetica-Bold').fontSize(9.5)
    .text(user.company || '', M + 5, y + 5, { width: leftW - 10 });
  const sellerLines = [
    [user.address, user.city].filter(Boolean).join(', '),
    user.gstNumber && `GSTIN : ${user.gstNumber}`,
    user.panNumber && `PAN : ${user.panNumber}`,
    user.mobile && `Ph : ${user.mobile}`
  ].filter(Boolean);
  doc.font('Helvetica').fontSize(7.5)
    .text(sellerLines.join('\n'), M + 5, doc.y + 2, { width: leftW - 10 });

  const buyerY = y + sellerH;
  const buyerH = rightBottom - buyerY;
  doc.lineWidth(0.7).rect(M, buyerY, leftW, buyerH).stroke();
  doc.font('Helvetica').fontSize(6).fillColor('#333')
    .text('BUYER', M + 5, buyerY + 4, { width: leftW - 10 });
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(9.5)
    .text(trip.consignee?.name || trip.partyName || '', M + 5, buyerY + 13, { width: leftW - 10 });
  const buyerLines = [
    trip.consignee?.address,
    trip.consignee?.gst && `GSTIN            : ${trip.consignee.gst}`,
    trip.consignee?.contact && `Contact         : ${trip.consignee.contact}`,
    trip.fromLocation && `Place of supply : ${trip.fromLocation}`
  ].filter(Boolean);
  doc.font('Helvetica').fontSize(7.5)
    .text(buyerLines.join('\n'), M + 5, doc.y + 2, { width: leftW - 10 });

  y = rightBottom;

  // --- Item table --------------------------------------------------------
  // Column widths follow the reference: a wide description, then narrow
  // numeric columns pinned to the right edge.
  const cols = [
    { key: 'sl', label: 'Sl\nNo.', w: 26, align: 'center' },
    { key: 'desc', label: 'Description of Goods', w: 0, align: 'left' },
    { key: 'qty', label: 'Quantity', w: 58, align: 'right' },
    { key: 'rate', label: 'Rate', w: 56, align: 'right' },
    { key: 'per', label: 'per', w: 34, align: 'center' },
    { key: 'amount', label: 'Amount', w: 78, align: 'right' },
    { key: 'gst', label: 'GST\n%', w: 34, align: 'center' }
  ];
  const fixed = cols.reduce((s, c) => s + c.w, 0);
  cols.find((c) => c.key === 'desc').w = W - fixed;

  const headH = 24;
  let cx = M;
  cols.forEach((c) => {
    doc.lineWidth(0.7).rect(cx, y, c.w, headH).stroke();
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#000')
      .text(c.label, cx + 2, y + 5, { width: c.w - 4, align: c.align === 'right' ? 'right' : c.align, lineGap: 1 });
    c.x = cx;
    cx += c.w;
  });
  y += headH;

  // Tall body block, like the reference's open item area. The single freight
  // line prints at the top; the VAT/GST line sits a few rows below it.
  const bodyH = 150;
  cols.forEach((c) => { doc.lineWidth(0.7).rect(c.x, y, c.w, bodyH).stroke(); });

  const rate = Number(trip.goods?.freightRate || 0);
  const gstRate = Number(trip.gstRate || 0);
  const taxable = Number(trip.amount || 0) + Number(trip.lrCharges || 0);
  const taxAmount = +(taxable * gstRate / 100).toFixed(2);

  const cellText = (key, text, dy, opts = {}) => {
    const c = cols.find((k) => k.key === key);
    doc.font(opts.font || 'Helvetica').fontSize(opts.size || 8.5).fillColor('#000')
      .text(text, c.x + 3, y + dy, { width: c.w - 6, align: opts.align || c.align, lineBreak: opts.wrap !== false });
  };

  cellText('sl', '1', 6);
  const descParts = [
    trip.goods?.description || 'Freight charges',
    trip.fromLocation && trip.toLocation ? `${trip.fromLocation} to ${trip.toLocation}` : '',
    trip.truck ? `Truck: ${trip.truck}` : '',
    trip.lr ? `LR No.: ${trip.lr}` : ''
  ].filter(Boolean);
  cellText('desc', descParts.join('\n'), 6, { size: 8.5 });
  cellText('qty', qtyOf(trip), 6);
  cellText('rate', rate ? INR(rate) : '', 6);
  cellText('per', trip.goods?.unit || '', 6);
  cellText('amount', INR(taxable), 6, { font: 'Helvetica-Bold' });
  cellText('gst', gstRate ? `${gstRate} %` : '', 6);

  // GST line, indented and italicised the way the reference shows VAT.
  if (gstRate) {
    cellText('desc', 'GST', 52, { font: 'Helvetica-BoldOblique', size: 9, align: 'right' });
    cellText('amount', INR(taxAmount), 52);
  }

  // Rounding/total strip at the foot of the item block.
  const totalRowH = 20;
  const totalY = y + bodyH;
  const grand = taxable + taxAmount;
  cols.forEach((c) => { doc.lineWidth(0.7).rect(c.x, totalY, c.w, totalRowH).stroke(); });
  const totalLabel = cols.find((c) => c.key === 'desc');
  doc.font('Helvetica-Bold').fontSize(8.5)
    .text('Total', totalLabel.x + 3, totalY + 6, { width: totalLabel.w - 6, align: 'right' });
  const qtyCol = cols.find((c) => c.key === 'qty');
  doc.font('Helvetica-Bold').fontSize(8.5)
    .text(qtyOf(trip), qtyCol.x + 3, totalY + 6, { width: qtyCol.w - 6, align: 'right' });
  const amtCol = cols.find((c) => c.key === 'amount');
  doc.font('Helvetica-Bold').fontSize(9)
    .text(`Rs. ${INR(grand)}`, amtCol.x + 3, totalY + 6, { width: amtCol.w - 6, align: 'right' });
  y = totalY + totalRowH;

  // --- Amount in words + tax summary ------------------------------------
  doc.font('Helvetica').fontSize(6.5).fillColor('#333')
    .text('E. & O.E', M, y + 2, { width: W - 4, align: 'right' });
  doc.fillColor('#000');
  y += 11;

  const wordsW = Math.round(W * 0.55);
  const summaryW = W - wordsW;
  const wordsH = 46;

  doc.lineWidth(0.7).rect(M, y, wordsW, wordsH).stroke();
  doc.font('Helvetica').fontSize(6.5).fillColor('#333')
    .text('Amount Chargeable (in words)', M + 4, y + 4, { width: wordsW - 8 });
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(8)
    .text(`${amountInWords(grand)}`, M + 4, y + 14, { width: wordsW - 8 });

  // Tax summary: taxable value and tax amount by rate, then a totals row.
  const sx = M + wordsW;
  const sCols = [
    { label: 'GST %', w: summaryW * 0.24, align: 'center' },
    { label: 'Assessable Value', w: summaryW * 0.40, align: 'right' },
    { label: 'Tax Amount', w: summaryW * 0.36, align: 'right' }
  ];
  const sHeadH = 14;
  let scx = sx;
  sCols.forEach((c) => {
    doc.lineWidth(0.7).rect(scx, y, c.w, sHeadH).stroke();
    doc.font('Helvetica').fontSize(6.5)
      .text(c.label, scx + 2, y + 4, { width: c.w - 4, align: c.align });
    c.x = scx;
    scx += c.w;
  });

  const sRowH = 15;
  const sRows = [
    [gstRate ? `${gstRate} %` : '', INR(taxable), INR(taxAmount), false],
    ['Total', INR(taxable), INR(taxAmount), true]
  ];
  sRows.forEach(([a, b, c, bold], i) => {
    const ry = y + sHeadH + i * sRowH;
    sCols.forEach((col) => { doc.lineWidth(0.7).rect(col.x, ry, col.w, sRowH).stroke(); });
    const font = bold ? 'Helvetica-Bold' : 'Helvetica';
    doc.font(bold ? 'Helvetica-BoldOblique' : font).fontSize(7.5)
      .text(a, sCols[0].x + 2, ry + 4, { width: sCols[0].w - 4, align: bold ? 'right' : 'center' });
    doc.font(font).fontSize(7.5)
      .text(b, sCols[1].x + 2, ry + 4, { width: sCols[1].w - 4, align: 'right' });
    doc.font(font).fontSize(7.5)
      .text(c, sCols[2].x + 2, ry + 4, { width: sCols[2].w - 4, align: 'right' });
  });
  y += Math.max(wordsH, sHeadH + sRows.length * sRowH);

  // Tax amount in words spans the full width, as on the reference.
  const taxWordsH = 24;
  doc.lineWidth(0.7).rect(M, y, W, taxWordsH).stroke();
  doc.font('Helvetica').fontSize(6.5).fillColor('#333')
    .text('Tax Amount (in words)', M + 4, y + 3, { width: W - 8 });
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(8)
    .text(`${amountInWords(taxAmount)}`, M + 4, y + 12, { width: W - 8 });
  y += taxWordsH;

  // --- Declaration + bank + signature ------------------------------------
  const footH = 84;
  const declW = Math.round(W * 0.55);
  doc.lineWidth(0.7).rect(M, y, declW, footH).stroke();
  doc.font('Helvetica-Bold').fontSize(6.5).text('Declaration', M + 4, y + 4, { width: declW - 8 });
  doc.font('Helvetica').fontSize(7).text(
    'We declare that this invoice shows the actual price of the goods described and that all particulars are ' +
    'true and correct.',
    M + 4, y + 13, { width: declW - 8 }
  );

  const b = user.bankDetails || {};
  const bankLines = [
    b.bankName && `Bank : ${b.bankName}`,
    b.accountNumber && `A/c No. : ${b.accountNumber}`,
    b.ifscCode && `IFSC : ${b.ifscCode}`,
    b.branchName && `Branch : ${b.branchName}`
  ].filter(Boolean);
  if (bankLines.length) {
    doc.font('Helvetica-Bold').fontSize(6.5)
      .text("Company's Bank Details", M + 4, y + 36, { width: declW - 8 });
    doc.font('Helvetica').fontSize(7)
      .text(bankLines.join('\n'), M + 4, y + 45, { width: declW - 8 });
  }

  const signW = W - declW;
  doc.lineWidth(0.7).rect(M + declW, y, signW, footH).stroke();
  doc.font('Helvetica-Bold').fontSize(8)
    .text(`for ${user.company || ''}`, M + declW + 5, y + 5, { width: signW - 10, align: 'right' });
  // The block is right-aligned, so the mark occupies the right half of the cell
  // to sit under the company line rather than floating in the middle.
  signatureMark(doc, user, M + declW + signW / 2, y + 16, signW / 2, footH - 34);
  const invSignatory = user.signature?.signatoryName;
  if (invSignatory) {
    doc.font('Helvetica').fontSize(7).fillColor('#000')
      .text(invSignatory, M + declW + 5, y + footH - 23, { width: signW - 10, align: 'right' });
  }
  doc.font('Helvetica').fontSize(7).fillColor('#333')
    .text('Authorised Signatory', M + declW + 5, y + footH - 14, { width: signW - 10, align: 'right' });
  doc.fillColor('#000');
  y += footH;

  doc.lineWidth(1.2).rect(M, frameTop, W, y - frameTop).stroke();

  doc.font('Helvetica').fontSize(7).fillColor('#333')
    .text('This is a Computer Generated Invoice', M, y + 6, { width: W, align: 'center' });
  doc.fillColor('#000');
};

// ---------------------------------------------------------------------------
// Goods Declaration â€” the consignor's statement of what is being carried.
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
    [trip.driver?.name, trip.driver?.mobile].filter(Boolean).join(' â€” '));
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
    // Only the transporter's own column is pre-signed; the consignor and driver
    // still sign these by hand at pickup.
    if (i === cols.length - 1) {
      signatureMark(doc, user, cxx, y + 4, width, signH - 24);
    }
    doc.font('Helvetica').fontSize(7.5).fillColor('#555')
      .text(label, cxx + 4, y + signH - 16, { width: width - 8, align: 'center' });
  });
  doc.fillColor('#000');
  y += signH;

  doc.lineWidth(1.2).rect(M, outerTop, W, y - outerTop).stroke();
};

