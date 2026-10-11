import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { STORE_INFO } from "./storeInfo";
import { getRole, getUserData } from "./auth";

const PINK = [255, 95, 147];
const DARK = [31, 41, 55];
const MUTED = [100, 116, 139];
const PALE = [255, 241, 247];
const BORDER = [226, 232, 240];

const text = (value, fallback = "—") => {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value).replaceAll("₱", "PHP ");
};

const pageBreakIfNeeded = (doc, y, required = 30) => {
  const bottom = doc.internal.pageSize.getHeight() - 18;
  if (y + required > bottom) {
    doc.addPage();
    return 18;
  }
  return y;
};

const sectionHeading = (doc, number, title, y) => {
  y = pageBreakIfNeeded(doc, y, 13);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...PINK);
  doc.text(`${number}. ${title.toUpperCase()}`, 14, y);
  doc.setDrawColor(...BORDER);
  doc.line(14, y + 2, doc.internal.pageSize.getWidth() - 14, y + 2);
  return y + 8;
};

const defaultSignatures = (preparedBy, preparedRole, employeeName) => [
  { role: "Prepared by", name: preparedBy, caption: preparedRole || "Report Preparer" },
  { role: "Reviewed by", name: "", caption: "Authorized Reviewer" },
  { role: employeeName ? "Received by" : "Approved by", name: employeeName || "", caption: employeeName ? "Employee Acknowledgment" : "Approving Officer" },
];

export const exportFormalReportPDF = (config = {}) => {
  const {
    docRef = `RPT-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`,
    title = "Business Report",
    subtitle = "Formal report",
    periodLabel = "Not specified",
    infoFields = [],
    summaryCards = [],
    analysis = null,
    table = { columns: [], rows: [] },
    findings = [],
    recommendations = [],
    certification = "I certify that this report presents the records and calculations available to the organization as of the issue date. Supporting records should be retained with this report.",
    signatures,
    filename = "formal-report",
    orientation = "portrait",
    subject,
    preparedBy: configuredPreparedBy,
    preparedRole: configuredPreparedRole,
  } = config;

  const doc = new jsPDF({ orientation, unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const generatedAt = new Date();
  const user = getUserData();
  const preparedBy = configuredPreparedBy || user.name || "Authorized Staff";
  const preparedRole = configuredPreparedRole || getRole() || "Report Preparer";
  const resolvedSignatures = signatures || defaultSignatures(preparedBy, preparedRole);
  let y = 15;

  doc.setProperties({
    title: text(title),
    subject: text(subject || subtitle),
    author: text(preparedBy),
    creator: STORE_INFO.name,
  });

  // Letterhead and document control details.
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(...PINK);
  doc.text(STORE_INFO.name, 14, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(...MUTED);
  doc.text(STORE_INFO.tagline, 14, y + 5);
  doc.text(`${STORE_INFO.address.replace(/\n/g, " ")} | ${STORE_INFO.email} | ${STORE_INFO.phone}`, 14, y + 9);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...DARK);
  doc.text(`DOC REF: ${text(docRef)}`, pageWidth - 14, y, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...MUTED);
  doc.text(`ISSUED: ${generatedAt.toLocaleDateString("en-PH")}`, pageWidth - 14, y + 5, { align: "right" });
  doc.setDrawColor(...PINK);
  doc.setLineWidth(0.7);
  doc.line(14, y + 13, pageWidth - 14, y + 13);
  y += 21;

  // Report title block.
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(...DARK);
  const titleLines = doc.splitTextToSize(text(title), pageWidth - 28);
  doc.text(titleLines, pageWidth / 2, y, { align: "center" });
  y += titleLines.length * 7;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  const subtitleLines = doc.splitTextToSize(text(subtitle), pageWidth - 28);
  doc.text(subtitleLines, pageWidth / 2, y, { align: "center" });
  y += subtitleLines.length * 4.5 + 2;
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...DARK);
  doc.text(`REPORTING PERIOD: ${text(periodLabel)}`, pageWidth / 2, y, { align: "center" });
  y += 9;

  // Section I: report information.
  y = sectionHeading(doc, "I", "Report Information", y);
  const fields = [
    { label: "Document Reference", value: docRef },
    { label: "Date Issued", value: generatedAt.toLocaleString("en-PH") },
    { label: "Reporting Period", value: periodLabel },
    { label: "Prepared By", value: preparedBy },
    ...infoFields,
  ];
  const colWidth = (pageWidth - 28) / 2;
  const infoStartY = y;
  fields.forEach((field, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = 14 + col * colWidth;
    let fy = infoStartY + row * 10;
    if (col === 0) {
      fy = pageBreakIfNeeded(doc, fy, 12);
      if (fy !== infoStartY + row * 10) y = fy;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(`${text(field.label)}:`, x, fy);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...DARK);
    const valueLines = doc.splitTextToSize(text(field.value), colWidth - 28);
    doc.text(valueLines, x + 27, fy);
  });
  y = Math.max(y, infoStartY + Math.ceil(fields.length / 2) * 10) + 5;

  // Section II: executive summary.
  if (summaryCards.length) {
    y = sectionHeading(doc, "II", "Executive Summary", y);
    const gap = 3;
    const cardWidth = (pageWidth - 28 - gap * (summaryCards.length - 1)) / summaryCards.length;
    const cardHeight = 20;
    y = pageBreakIfNeeded(doc, y, cardHeight + 6);
    summaryCards.forEach((card, index) => {
      const x = 14 + index * (cardWidth + gap);
      doc.setFillColor(...PALE);
      doc.setDrawColor(...BORDER);
      doc.roundedRect(x, y, cardWidth, cardHeight, 2, 2, "FD");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(summaryCards.length > 4 ? 9 : 11);
      doc.setTextColor(...PINK);
      const valueLines = doc.splitTextToSize(text(card.value), cardWidth - 4);
      doc.text(valueLines.slice(0, 1), x + cardWidth / 2, y + 8, { align: "center" });
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.5);
      doc.setTextColor(...DARK);
      doc.text(doc.splitTextToSize(text(card.label), cardWidth - 4).slice(0, 1), x + cardWidth / 2, y + 14, { align: "center" });
      if (card.sub) {
        doc.setFontSize(5.8);
        doc.setTextColor(...MUTED);
        doc.text(doc.splitTextToSize(text(card.sub), cardWidth - 4).slice(0, 1), x + cardWidth / 2, y + 18, { align: "center" });
      }
    });
    y += cardHeight + 6;
  }

  // Section III: optional analysis table.
  if (analysis?.columns?.length && analysis.rows?.length) {
    y = sectionHeading(doc, "III", analysis.title || "Analysis", y);
    autoTable(doc, {
      startY: y,
      head: [analysis.columns.map((column) => column.header || column.label || column.key)],
      body: analysis.rows.map((row) => analysis.columns.map((column) => {
        const value = typeof column.value === "function" ? column.value(row) : row[column.key];
        return typeof column.format === "function" ? text(column.format(value, row), "") : text(value, "");
      })),
      theme: "grid",
      margin: { left: 14, right: 14, bottom: 18 },
      styles: { font: "helvetica", fontSize: 7.5, cellPadding: 2.2, textColor: DARK, overflow: "linebreak" },
      headStyles: { fillColor: PINK, textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [250, 250, 250] },
      didDrawPage: () => {},
    });
    y = doc.lastAutoTable.finalY + 7;
  }

  // Main detailed-record table.
  const detailSectionNumber = analysis?.columns?.length && analysis.rows?.length ? "IV" : summaryCards.length ? "III" : "II";
  y = sectionHeading(doc, detailSectionNumber, table.title || "Detailed Records", y);
  const columns = table.columns || [];
  const rows = table.rows || [];
  autoTable(doc, {
    startY: y,
    head: [columns.map((column) => column.header || column.label || column.key)],
    body: rows.map((row) => columns.map((column) => {
      const value = typeof column.value === "function" ? column.value(row) : row[column.key];
      if (typeof column.format === "function") return text(column.format(value, row), "");
      return text(value, "");
    })),
    ...(table.foot ? { foot: [table.foot] } : {}),
    showHead: "everyPage",
    showFoot: "lastPage",
    theme: "grid",
    margin: { left: 14, right: 14, bottom: 18 },
    styles: { font: "helvetica", fontSize: table.fontSize || 7, cellPadding: 2, textColor: DARK, overflow: "linebreak" },
    headStyles: { fillColor: PINK, textColor: 255, fontStyle: "bold" },
    footStyles: { fillColor: [255, 241, 247], textColor: DARK, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [250, 250, 250] },
    columnStyles: Object.fromEntries(columns.map((column, index) => [index, {
      ...(column.align ? { halign: column.align } : {}),
      ...(column.width ? { cellWidth: column.width } : {}),
    }])),
    ...(table.didParseCell ? { didParseCell: table.didParseCell } : {}),
    ...(table.didDrawPage ? { didDrawPage: table.didDrawPage } : {}),
  });
  y = doc.lastAutoTable.finalY + 7;

  // Findings and recommendations provide narrative context, not just a list of records.
  const narrative = [...findings.map((item) => ({ title: "Finding", text: item })), ...recommendations.map((item) => ({ title: "Recommendation", text: item }))];
  if (narrative.length) {
    const narrativeSectionNumber = detailSectionNumber === "IV" ? "V" : "IV";
    y = sectionHeading(doc, narrativeSectionNumber, "Findings & Recommendations", y);
    narrative.forEach((item, index) => {
      const lines = doc.splitTextToSize(`${index + 1}. ${item.title}: ${text(item.text)}`, pageWidth - 30);
      y = pageBreakIfNeeded(doc, y, lines.length * 4.5 + 4);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...DARK);
      doc.text(lines, 15, y);
      y += lines.length * 4.5 + 2;
    });
  }

  // Certification and signatures.
  const signatureSectionNumber = narrative.length ? (detailSectionNumber === "IV" ? "VI" : "V") : (detailSectionNumber === "IV" ? "V" : "IV");
  const signatureHeight = 56;
  y = pageBreakIfNeeded(doc, y + 2, signatureHeight);
  y = sectionHeading(doc, signatureSectionNumber, "Certification & Signatures", y);
  const certLines = doc.splitTextToSize(text(certification), pageWidth - 28);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...DARK);
  doc.text(certLines, 14, y);
  y += certLines.length * 4.2 + 17;

  const signatureGap = 7;
  const signatureWidth = (pageWidth - 28 - signatureGap * 2) / 3;
  resolvedSignatures.slice(0, 3).forEach((signature, index) => {
    const x = 14 + index * (signatureWidth + signatureGap);
    doc.setDrawColor(...MUTED);
    doc.setLineWidth(0.3);
    doc.line(x, y, x + signatureWidth, y);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...DARK);
    doc.text(text(signature.name, " "), x, y + 4);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    doc.text(text(signature.role), x, y + 8);
    doc.text(text(signature.caption), x, y + 12);
    doc.text("Date Signed: __________________", x, y + 17);
  });

  // Confidentiality and page numbering on every page.
  const pageCount = doc.internal.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.25);
    doc.line(14, pageHeight - 13, pageWidth - 14, pageHeight - 13);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    doc.text(`${text(docRef)} | ${STORE_INFO.name} | For authorized business use`, 14, pageHeight - 8);
    doc.text(`Page ${page} of ${pageCount}`, pageWidth - 14, pageHeight - 8, { align: "right" });
  }

  const safeFilename = text(filename, "formal-report").replace(/[<>:"/\\|?*]+/g, "-");
  doc.save(`${safeFilename}.pdf`);
  return doc;
};
