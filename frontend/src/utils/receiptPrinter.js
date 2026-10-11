/**
 * Shared receipt printing utility.
 *
 * Printing order:
 *   1. Try QZ Tray with raw ESC/POS commands (silent, no dialog, no popup).
 *      The printer renders with its built-in firmware fonts — no font or
 *      DPI/scaling issues.
 *   2. Fall back to a compact browser popup + auto-print dialog.
 *
 * The HTML path below is the browser fallback — also the design that the
 * on-screen modal previews mirror. Optimised for 58mm thermal paper.
 *
 * Used by all cashier, customer, and payment-verification receipt flows.
 */
import { STORE_INFO, computeVatBreakdown } from "./storeInfo";
import { printRawViaQZ } from "./qzPrinter";
import { buildEscPos, buildTestReceipt } from "./escpos";

/**
 * Print a receipt.
 *
 * @param {Object}  opts
 * @param {string}  opts.title           - Receipt title
 * @param {string}  opts.receiptNumber   - Receipt / transaction number
 * @param {string}  opts.date            - Formatted date string
 * @param {string}  [opts.cashier]       - Cashier name
 * @param {string}  [opts.customer]      - Customer name
 * @param {string}  [opts.paymentMethod] - Payment method (cash, gcash, maya…)
 * @param {string}  [opts.paymentStatus] - paid | pending | failed
 * @param {string}  [opts.referenceNumber]
 * @param {Array}   opts.items           - [{ name, quantity, unitPrice, total }]
 * @param {number}  opts.subtotal
 * @param {number}  [opts.vat]
 * @param {number}  [opts.discount]
 * @param {number}  opts.total
 * @param {number}  [opts.amountReceived] - Cash received (cash payments)
 * @param {number}  [opts.change]         - Change due
 * @param {string}  [opts.verifiedBy]
 * @param {string}  [opts.footerText]
 */
export async function printReceipt(opts = {}) {
  // 1. Try silent QZ Tray print via raw ESC/POS — printer's own fonts
  const printedViaQZ = await printRawViaQZ(buildEscPos(opts));
  if (printedViaQZ) return;

  // 2. Fall back to browser popup — include Print button in case auto-print fails
  const htmlForPopup = buildReceiptHtml(opts, { includePrintButton: true });
  openPrintPopup(htmlForPopup);
}

// Dev helper: print an ESC/POS diagnostic page from the browser console.
// Usage: __printTestReceipt()
if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__printTestReceipt = () => printRawViaQZ(buildTestReceipt());
}

// ── HTML builder ─────────────────────────────────────────────────────────────

function buildReceiptHtml(opts = {}, { includePrintButton = false } = {}) {
  const {
    title = "Invoice",
    receiptNumber = "",
    date = new Date().toLocaleString("en-PH"),
    cashier = "",
    customer = "Walk-in",
    paymentMethod = "cash",
    paymentStatus = "paid",
    referenceNumber = "",
    items = [],
    subtotal = 0,
    vat,
    discount = 0,
    total = 0,
    amountReceived,
    change,
    verifiedBy = "",
    footerText = "Thank you for choosing Pawesome Retreat Inc.!",
  } = opts;

  const vatBreakdown = computeVatBreakdown(total);
  const vatAmount    = vat != null ? Number(vat) : vatBreakdown.vatAmount;

  const EQ = `<div class="dv">&nbsp;</div>`;

  // ── Items HTML — one row per item: name left, price right; qty line below ──
  const itemsHtml = items.map((item) => {
    const name      = item.name || item.item_name || "Item";
    const qty       = item.quantity || 1;
    const unitPrice = Number(item.unitPrice || item.unit_price || 0);
    const itemTotal = Number(item.total || item.total_price || unitPrice * qty);
    return `<div class="it">
  <div class="i1"><span>${e(name)}</span><span>${php(itemTotal)}</span></div>
  <div class="i2">${qty} x ${php(unitPrice)}</div>
</div>`;
  }).join("");

  // ── Meta rows ───────────────────────────────────────────────
  const metaHtml = [
    rw("Receipt #",  e(receiptNumber)),
    rw("Date",       e(date)),
    cashier         ? rw("Cashier",   e(cashier))          : "",
    rw("Customer",   e(customer)),
    rw("Payment",    e(paymentMethod.toUpperCase())),
    referenceNumber ? rw("Ref #",     e(referenceNumber))  : "",
    verifiedBy      ? rw("Verified",  e(verifiedBy))       : "",
  ].filter(Boolean).join("");

  // ── Totals block: subtotal, VAT, discount, TOTAL, cash, change ──
  const totalsHtml = [
    rw("Subtotal", php(subtotal)),
    rw("VAT 12%",  `-${php(Math.abs(vatAmount))}`),
    discount > 0 ? rw("Discount", `-${php(discount)}`) : "",
  ].filter(Boolean).join("");

  const cashHtml = [
    amountReceived != null ? rw("Cash",    php(amountReceived)) : "",
    change != null         ? rw("Change",  php(change))         : "",
  ].filter(Boolean).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${e(title)}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      font-family:'OCR-B 10 BT','OCR B',monospace;
      background:#eee;
      padding:10px 4px 16px;
    }
    .w{width:100%;max-width:300px;background:#fff;border:1px solid #999;overflow:hidden}

    /* Section spacer */
    .dv{height:6px}

    /* Header — left-aligned, no letter-spacing */
    .hd{padding:10px 10px 4px}
    .hd .n{font-size:15px;font-weight:900;color:#000;margin-bottom:2px}
    .hd .a,.hd .m{font-size:10px;color:#000;line-height:1.4}
    .hd .t{font-size:12px;font-weight:700;color:#000;text-transform:uppercase;margin-top:6px}

    /* Label + value rows */
    .mr{display:flex;justify-content:space-between;padding:3px 10px;font-size:13px;color:#000}
    .mr .v{font-weight:600;text-align:right}

    /* Items */
    .it{padding:2px 10px 4px}
    .i1{display:flex;justify-content:space-between;font-size:13px;font-weight:700;color:#000}
    .i1 span:first-child{padding-right:6px}
    .i2{font-size:10px;color:#000;padding-left:12px}

    /* TOTAL row */
    .tt{display:flex;justify-content:space-between;padding:6px 10px;font-size:18px;font-weight:900;color:#000}

    /* Footer */
    .ft{padding:8px 10px 12px;text-align:center}
    .ft p{font-size:10.5px;color:#000;line-height:1.5}

    /* Print button — screen only */
    .pb{display:block;width:calc(100% - 20px);margin:6px 10px 12px;padding:10px;font-family:'OCR-B 10 BT','OCR B',monospace;font-size:13px;font-weight:700;cursor:pointer;background:#000;color:#fff;border:none}
    .pb:hover{opacity:.8}

    @media print{
      body{background:#fff;padding:0}
      .w{max-width:100%;width:100%}
      .pb{display:none!important}
      @page{size:58mm auto;margin:0}
    }
  </style>
</head>
<body>
  <div class="w">

    <!-- Header -->
    <div class="hd">
      <div class="n">${e(STORE_INFO.name)}</div>
      <div class="a">${e(STORE_INFO.address).replace(/\n/g, "<br>")}</div>
      <div class="m">${e(STORE_INFO.email)}</div>
      <div class="t">${e(title)}</div>
    </div>

    ${EQ}

    ${metaHtml}

    ${itemsHtml}

    ${totalsHtml}

    ${EQ}

    <div class="tt"><span>TOTAL</span><span>${php(total)}</span></div>

    ${cashHtml}

    <div class="ft"><p>${e(footerText)}</p></div>

    ${EQ}

    ${includePrintButton ? `<button class="pb" onclick="window.print()">PRINT RECEIPT</button>` : ""}
  </div>
</body>
</html>`;
}

// ── Popup fallback ────────────────────────────────────────────────────────────

function openPrintPopup(html) {
  const w = window.open("", "_blank", "width=360,height=640,scrollbars=yes");
  if (!w) {
    alert("Please allow pop-ups to print the receipt.");
    return;
  }
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => {
    try { w.print(); } catch { /* user can click Print button */ }
  }, 350);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Label + value meta row */
function rw(label, valueHtml) {
  return `<div class="mr"><span class="l">${e(label)}</span><span class="v">${valueHtml}</span></div>`;
}

function php(value) {
  const n = Number(value) || 0;
  return "P" + n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function e(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
