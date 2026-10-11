/**
 * ESC/POS raw receipt builder for 58mm thermal printers.
 *
 * Instead of rasterizing HTML, this emits plain text + ESC/POS control
 * bytes so the printer renders using its own built-in firmware fonts —
 * no font files, DPI scaling, or driver margins involved.
 *
 * Line widths (generic POS-58 / Epson-compatible):
 *   Font A  = 12x24 dots  -> 32 chars per line
 *   Font B  =  9x17 dots  -> 42 chars per line
 *
 * All emitted bytes are < 0x80 (text is ASCII-sanitized), so output is
 * encoding-safe regardless of the transport charset.
 */
import { STORE_INFO, computeVatBreakdown } from "./storeInfo";

// ── ESC/POS commands ─────────────────────────────────────────────────────────
const INIT     = "\x1B@";        // initialize printer
const LEFT     = "\x1Ba\x00";    // align left
const CENTER   = "\x1Ba\x01";    // align center
const FONT_A   = "\x1BM\x00";    // Font A — 32 cols
const FONT_B   = "\x1BM\x01";    // Font B — 42 cols (smaller)
const BOLD_ON  = "\x1BE\x01";
const BOLD_OFF = "\x1BE\x00";
const DBL      = "\x1D!\x11";    // double width + height (16 cols)
const NORMAL   = "\x1D!\x00";    // normal size
const CUT      = "\x1DV\x42\x03"; // feed 3 lines + partial cut

const COLS     = 32;             // Font A columns on 58mm
const COLS_B   = 42;             // Font B columns
const COLS_DBL = 16;             // double-width columns

// ── Text helpers ─────────────────────────────────────────────────────────────

/** Strip accents and force pure ASCII — thermal code pages lack ñ/₱/etc. */
function asc(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/₱/g, "P")
    .replace(/[^\x20-\x7E]/g, "?");
}

/** Label left + value right-aligned within `cols`. Overflow wraps value. */
function row(left, right, cols = COLS) {
  left = asc(left);
  right = asc(right);
  const gap = cols - left.length - right.length;
  if (gap < 1) return left.slice(0, cols) + "\n" + right.padStart(cols);
  return left + " ".repeat(gap) + right;
}

/** Word-wrap text into lines of `width`, optionally indented. */
function wrap(text, width, indent = "") {
  const words = asc(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = indent;
  for (const w of words) {
    if (cur.trim() && cur.length + w.length > width) {
      lines.push(cur.trimEnd());
      cur = indent + w + " ";
    } else {
      cur += w + " ";
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

function php(value) {
  const n = Number(value) || 0;
  return "P" + n.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ── Receipt builder ──────────────────────────────────────────────────────────

/**
 * Build a raw ESC/POS receipt.
 * Accepts the same opts object as buildReceiptHtml() in receiptPrinter.js.
 */
export function buildEscPos(opts = {}) {
  const {
    title           = "Invoice",
    receiptNumber   = "",
    date            = new Date().toLocaleString("en-PH"),
    cashier         = "",
    customer        = "Walk-in",
    paymentMethod   = "cash",
    referenceNumber = "",
    items           = [],
    subtotal        = 0,
    vat,
    discount        = 0,
    total           = 0,
    amountReceived,
    change,
    verifiedBy      = "",
    footerText      = "Thank you for choosing Pawesome Retreat Inc.!",
  } = opts;

  const vatBreakdown = computeVatBreakdown(total);
  const vatAmount    = vat != null ? Number(vat) : vatBreakdown.vatAmount;

  let out = INIT;

  // ── Header (centered) ──
  out += CENTER;
  out += BOLD_ON + asc(STORE_INFO.name).toUpperCase() + "\n" + BOLD_OFF;
  out += FONT_B;
  for (const l of STORE_INFO.address.split("\n"))
    for (const line of wrap(l, COLS_B)) out += line + "\n";
  out += asc(STORE_INFO.email) + "\n";
  out += FONT_A;
  out += BOLD_ON + asc(title).toUpperCase() + "\n" + BOLD_OFF;
  out += LEFT + "\n";

  // ── Meta rows ──
  out += row("Receipt #:", receiptNumber) + "\n";
  out += row("Date:", date) + "\n";
  if (cashier) out += row("Cashier:", cashier) + "\n";
  out += row("Customer:", customer) + "\n";
  out += row("Payment:", paymentMethod.toUpperCase()) + "\n";
  if (referenceNumber) out += row("Ref #:", referenceNumber) + "\n";
  if (verifiedBy) out += row("Verified:", verifiedBy) + "\n";

  // ── Items ──
  if (items.length) {
    out += "\n";
    for (const item of items) {
      const name      = item.name || item.item_name || "Item";
      const qty       = item.quantity || 1;
      const unitPrice = Number(item.unitPrice || item.unit_price || 0);
      const itemTotal = Number(item.total || item.total_price || unitPrice * qty);
      for (const line of wrap(name, COLS)) out += line + "\n";
      out += row(`  ${qty} x ${php(unitPrice)}`, php(itemTotal)) + "\n";
    }
  }

  // ── Totals ──
  out += "\n";
  out += row("Subtotal", php(subtotal)) + "\n";
  out += row("VAT 12%", "-" + php(Math.abs(vatAmount))) + "\n";
  if (discount > 0) out += row("Discount", "-" + php(discount)) + "\n";
  out += "\n";
  out += DBL + row("TOTAL", php(total), COLS_DBL) + NORMAL + "\n";
  if (amountReceived != null) out += row("Cash", php(amountReceived)) + "\n";
  if (change != null) out += row("Change", php(change)) + "\n";

  // ── Footer ──
  out += "\n" + CENTER;
  for (const line of wrap(footerText, COLS)) out += line + "\n";
  out += LEFT;

  // ── Feed past cutter + cut ──
  out += "\n\n\n" + CUT;

  return out;
}

// ── Diagnostic test print ────────────────────────────────────────────────────

/**
 * One-shot printer diagnostic: alignment ruler, charset sample, bold and
 * double-size checks. If this prints cleanly, all receipts will too.
 */
export function buildTestReceipt() {
  let out = INIT;
  out += CENTER + BOLD_ON + "PAWESOME PRINTER TEST\n" + BOLD_OFF;
  out += FONT_B + "If this reads cleanly, ESC/POS works.\n" + FONT_A;
  out += LEFT + "\n";

  // Column ruler — 32 chars
  out += "12345678901234567890123456789012\n";
  out += "....5....0....5....0....5....0..\n\n";

  // Character sample
  out += "ABCDEFGHIJKLMNOPQRSTUVWXYZ\n";
  out += "abcdefghijklmnopqrstuvwxyz\n";
  out += "0123456789 !@#$%^&*()-_=+\n\n";

  // Style checks
  out += BOLD_ON + "BOLD TEXT TEST\n" + BOLD_OFF;
  out += DBL + "DOUBLE SIZE\n" + NORMAL;
  out += row("LEFT", "RIGHT") + "\n";
  out += CENTER + "CENTERED LINE\n" + LEFT;

  out += "\n\n\n" + CUT;
  return out;
}
