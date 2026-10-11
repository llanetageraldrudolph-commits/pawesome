import React, { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../../api/client";
import { showError } from "../../utils/alert.jsx";
import { printReceipt } from "../../utils/receiptPrinter";
import HistoryTimeline from "../shared/HistoryTimeline";
import { formatCurrency } from "../../utils/currency";
import "./CashierHistory_Polished.css";

const METHOD_OPTIONS = [
  { value: "cash",          label: "Cash" },
  { value: "gcash",         label: "GCash" },
  { value: "card",          label: "Card" },
  { value: "bank_transfer", label: "Bank Transfer" },
];

const CashierHistory = () => {
  const [entries, setEntries]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState("");
  const [searchTerm, setSearchTerm]   = useState("");
  const [dateFilter, setDateFilter]   = useState("all");
  const [methodFilter, setMethodFilter] = useState("all");
  const [page, setPage]               = useState(1);
  const [meta, setMeta]               = useState(null);

  const fetchHistory = useCallback(async (p = 1) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        page: p,
        per_page: 25,
        ...(searchTerm     && { search:      searchTerm     }),
        ...(dateFilter !== "all"   && { date_filter:   dateFilter   }),
        ...(methodFilter !== "all" && { method:        methodFilter }),
      });
      const res = await apiRequest(`/cashier/transactions?${params}`);
      const items = res?.transactions || res?.data || (Array.isArray(res) ? res : []);
      const mapped = items.map((t, i) => ({
        id:           t.id || `TRX-${i + 1}`,
        reference_id: t.id || `TRX-${i + 1}`,
        action:       "Transaction",
        description:  `${t.customer || t.customer_name || "Walk-in"} · ${t.method || t.payment_method || "cash"}`,
        amount:       Number(t.amount || t.total || 0),
        status:       t.status || "completed",
        category:     t.type || "pos_sale",
        actor:        t.customer || t.customer_name || "Walk-in",
        actor_role:   "cashier",
        method:       t.method || t.payment_method || "cash",
        receipt_number: t.receipt_number,
        payment_reference: t.payment_reference,
        created_at:   t.date || t.created_at,
        raw_data:     t,
      }));
      setEntries(mapped);
      setMeta(res?.meta || null);
    } catch (err) {
      setError(err.message || "Failed to load cashier history.");
      showError(err.message || "Failed to load cashier history.");
    } finally {
      setLoading(false);
    }
  }, [searchTerm, dateFilter, methodFilter]);

  useEffect(() => { fetchHistory(page); }, [fetchHistory, page]);

  const handlePageChange = (p) => { setPage(p); fetchHistory(p); };

  const handlePrintReceipt = (entry) => {
    const raw = entry.raw_data || {};
    const saleId = raw.transaction_id || raw.id;
    if (!saleId) return;

    const items = (raw.items || raw.products || []).map((item) => ({
      name: item.item_name || item.name || "Item",
      quantity: item.quantity || 1,
      unitPrice: Number(item.unit_price || item.price || item.total_price || 0),
      total: Number(item.total_price || (item.unit_price || item.price || 0) * (item.quantity || 1)),
    }));

    const total = Number(entry.amount || raw.total || raw.total_amount || 0);
    const subtotal = Number(raw.subtotal || total);
    const discount = Number(raw.discount || raw.discount_amount || 0);
    const amountReceived = Number(raw.amount_received || raw.cash_received || 0);
    const change = Number(raw.change || raw.change_amount || 0);

    printReceipt({
      title: "Sales Invoice",
      receiptNumber: entry.reference_id || String(saleId),
      date: entry.created_at ? new Date(entry.created_at).toLocaleString("en-PH") : new Date().toLocaleString("en-PH"),
      cashier: raw.cashier_name || entry.actor || "Cashier",
      customer: raw.customer_name || entry.actor || "Walk-in",
      paymentMethod: entry.method || raw.payment_method || "cash",
      paymentStatus: entry.status || raw.payment_status || "paid",
      referenceNumber: raw.reference_number || "",
      items,
      subtotal,
      vat: raw.tax || raw.vat_amount,
      discount,
      total,
      amountReceived: amountReceived || undefined,
      change: change || undefined,
    });
  };

  const exportColumns = [
    { key: "reference_id", label: "Reference" },
    { key: "actor", label: "Customer" },
    { key: "amount", label: "Amount", format: "currency" },
    { key: "method", label: "Method" },
    { key: "status", label: "Status" },
    { key: "created_at", label: "Date", format: "date" },
  ];

  return (
    <div className="cashier-history-page">
      <HistoryTimeline
      entries={entries}
      loading={loading}
      error={error}
      onRefresh={() => fetchHistory(page)}
      exportColumns={exportColumns}
      exportFilename="cashier-history"
      exportTitle="Cashier Transaction History"
      roleAccent="#0891b2"
      roleLabel="Cashier"
      emptyMessage="No transactions found. Adjust filters or refresh."
      searchTerm={searchTerm}
      onSearchChange={(v) => { setSearchTerm(v); setPage(1); }}
      dateFilter={dateFilter}
      onDateFilterChange={(v) => { setDateFilter(v); setPage(1); }}
      categoryFilter={methodFilter}
      onCategoryFilterChange={(v) => { setMethodFilter(v); setPage(1); }}
      categoryOptions={METHOD_OPTIONS}
      meta={meta}
      onPageChange={handlePageChange}
      renderEntryMeta={(entry) => (
        <button
          type="button"
          className="ht-receipt-btn"
          onClick={(e) => { e.stopPropagation(); handlePrintReceipt(entry); }}
          title="Print Receipt"
          style={{
            marginLeft: 8,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--ht-accent, #0891b2)",
            fontSize: 12,
          }}
        >
          🧾 Receipt
        </button>
      )}
      />
    </div>
  );
};

export default CashierHistory;

