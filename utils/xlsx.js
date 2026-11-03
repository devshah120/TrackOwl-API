import zlib from 'zlib';

// A minimal .xlsx writer for the report exports — one sheet, a bold header
// row, typed cells (text, number, money, date) and an optional totals row.
// Written here rather than pulling in a spreadsheet library because the need is
// this narrow and the format is plain XML in a zip.
//
// The zip is assembled by hand (local headers, central directory, CRC-32) with
// each entry deflated by Node's own zlib, so there is no dependency to install
// on the server.

// --- zip -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const zip = (files) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(data, 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
};

// --- sheet -----------------------------------------------------------------

const esc = (s) =>
  String(s)
    // Characters XML 1.0 cannot carry at all.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// Excel stores dates as days since 1899-12-30. Converted in IST so a trip on
// 1 Nov in India is 1 Nov in the sheet, not 31 Oct UTC.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const excelDate = (d) => (new Date(d).getTime() + IST_OFFSET_MS) / 86400000 + 25569;

// Style indexes into cellXfs below.
const S = { text: 0, header: 1, money: 2, date: 3, totalMoney: 4, number: 5, totalText: 6, datetime: 7, totalNumber: 8 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="dd-mmm-yyyy"/><numFmt numFmtId="166" formatCode="dd-mmm-yyyy hh:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF2FF"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs>
</styleSheet>`;

const cell = (ref, value, type, total = false) => {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'money' || type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    const style = type === 'money' ? (total ? S.totalMoney : S.money) : total ? S.totalNumber : S.number;
    return `<c r="${ref}" s="${style}"><v>${n}</v></c>`;
  }
  if (type === 'date' || type === 'datetime') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const serial = type === 'date' ? Math.floor(excelDate(d)) : excelDate(d);
    return `<c r="${ref}" s="${type === 'date' ? S.date : S.datetime}"><v>${serial}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr" s="${total ? S.totalText : S.text}"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
};

/**
 * @param {{ title: string, subtitle?: string, columns: {key,label,type}[], rows: object[], totals?: object, note?: string }} report
 * @returns {Buffer} the .xlsx file
 */
export const buildXlsx = (report) => {
  const cols = report.columns;
  const rowsXml = [];
  let r = 1;

  // Title and subtitle above the table, so a printed sheet says what it is.
  rowsXml.push(`<row r="${r}"><c r="A${r}" t="inlineStr" s="${S.totalText}"><is><t>${esc(report.title)}</t></is></c></row>`);
  r += 1;
  if (report.subtitle) {
    rowsXml.push(`<row r="${r}">${cell(`A${r}`, report.subtitle, 'text')}</row>`);
    r += 1;
  }
  r += 1;
  const headerRow = r;
  rowsXml.push(`<row r="${r}">${cols.map((c, i) => `<c r="${colName(i)}${r}" t="inlineStr" s="${S.header}"><is><t>${esc(c.label)}</t></is></c>`).join('')}</row>`);
  r += 1;

  for (const row of report.rows) {
    rowsXml.push(`<row r="${r}">${cols.map((c, i) => cell(`${colName(i)}${r}`, row[c.key], c.type)).join('')}</row>`);
    r += 1;
  }

  if (report.totals && Object.keys(report.totals).length) {
    rowsXml.push(
      `<row r="${r}">${cols
        .map((c, i) => (i === 0 ? cell(`A${r}`, 'TOTAL', 'text', true) : c.key in report.totals ? cell(`${colName(i)}${r}`, report.totals[c.key], c.type, true) : ''))
        .join('')}</row>`
    );
    r += 1;
  }
  if (report.note) {
    r += 1;
    rowsXml.push(`<row r="${r}">${cell(`A${r}`, report.note, 'text')}</row>`);
  }

  // Column widths from the header and the first rows' content.
  const widths = cols.map((c) => {
    const sample = report.rows.slice(0, 200).map((row) => String(row[c.key] ?? '').length);
    const w = Math.max(c.label.length, ...sample, c.type === 'date' ? 12 : c.type === 'datetime' ? 17 : 6);
    return Math.min(60, w + 2);
  });

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rowsXml.join('')}</sheetData>
<autoFilter ref="A${headerRow}:${colName(cols.length - 1)}${headerRow + report.rows.length}"/>
</worksheet>`;

  const sheetName = esc(String(report.title).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));

  return zip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${sheetName.replace(/'/g, "''")}'!$A$${headerRow}:$${colName(cols.length - 1)}$${headerRow + report.rows.length}</definedName></definedNames></workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: sheet }
  ]);
};
