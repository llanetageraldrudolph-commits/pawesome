import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { apiRequest } from "../../../api/client";
import { getToken } from "../../../utils/auth";
import { showSuccess, showError, showReasonPrompt, showConfirm, showAlert, PAYMENT_REJECT_REASONS } from "../../../utils/alert.jsx";
import { printReceipt as printReceiptUtil } from "../../../utils/receiptPrinter";
import { exportToCSV as exportCSVUtil, exportToPDF, exportToExcel } from "../../../utils/reportExport";

// Unique UI key per queue row — the queue unions five tables, so bare
// numeric ids collide across types (e.g. boarding #3 vs service_request #3).
export const paymentKey = (p) =>
  `${p?.payable_type || p?.type || "payment"}-${p?.id}`;

export const usePaymentApprovals = (user) => {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const rateLimitedRef = useRef(false);
  
  // Filter states
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [methodFilter, setMethodFilter] = useState("all");
  const [sortBy, setSortBy] = useState("date-desc");
  
  // Bulk selection
  const [selectedIds, setSelectedIds] = useState([]);
  
  // Proof modal
  const [proofModal, setProofModal] = useState(null);
  const proofRequestRef = useRef(null);
  const proofBlobUrlRef = useRef(null);

  // Fetch requests
  const fetchRequests = useCallback(async ({ silent = false } = {}) => {
    if (rateLimitedRef.current) return;
    try {
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      const data = await apiRequest("/cashier/payment-requests");
      const list = data?.data || data?.requests || data?.payments || data || [];
      setRequests(list);
      setLastUpdated(new Date());
    } catch (err) {
      if (err?.message?.toLowerCase().includes("too many") || err?.status === 429) {
        console.warn("Payment requests rate limited — pausing polling for 5 minutes.");
        rateLimitedRef.current = true;
        setTimeout(() => { rateLimitedRef.current = false; }, 5 * 60 * 1000);
      } else {
        console.error("Failed to load payment requests:", err);
      }
      if (!silent) setRequests([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial load and auto-refresh
  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchRequests({ silent: true });
    }, 60000);
    return () => clearInterval(interval);
  }, [fetchRequests]);

  // Proof modal handlers
  const openProof = useCallback(async (proofUrl, payment) => {
    proofRequestRef.current?.controller.abort();
    proofRequestRef.current = null;
    if (proofBlobUrlRef.current) {
      URL.revokeObjectURL(proofBlobUrlRef.current);
      proofBlobUrlRef.current = null;
    }

    if (!proofUrl) {
      setProofModal({ blobUrl: null, isPdf: false, loading: false, error: null, payment });
      return;
    }

    const controller = new AbortController();
    const requestId = Symbol("proof-request");
    proofRequestRef.current = { controller, requestId };
    setProofModal({ blobUrl: null, isPdf: false, loading: true, error: null, payment });

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20000);

    try {
      const token = getToken();
      const response = await fetch(proofUrl, {
        headers: {
          Accept: "image/*, application/pdf",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const message = response.status === 401 || response.status === 403
          ? "You do not have permission to view this proof. Refresh your session or contact an administrator."
          : response.status === 404
            ? "The payment proof file could not be found."
            : `Unable to load payment proof (HTTP ${response.status}).`;
        throw new Error(message);
      }

      const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const allowedTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
      if (!allowedTypes.includes(contentType)) {
        throw new Error(`The server returned an unsupported file type${contentType ? ` (${contentType})` : ""}.`);
      }

      const contentLength = Number(response.headers.get("content-length"));
      const maxFileSize = 5 * 1024 * 1024;
      if (contentLength > maxFileSize) {
        throw new Error("The proof file is too large to preview (maximum 5 MB).");
      }

      const blob = await response.blob();
      if (blob.size > maxFileSize) {
        throw new Error("The proof file is too large to preview (maximum 5 MB).");
      }

      if (proofRequestRef.current?.requestId !== requestId) return;

      const blobUrl = URL.createObjectURL(blob);
      proofBlobUrlRef.current = blobUrl;
      setProofModal({ blobUrl, isPdf: contentType === "application/pdf", loading: false, error: null, payment });
    } catch (error) {
      if (proofRequestRef.current?.requestId !== requestId) return;
      const message = timedOut
        ? "Loading the proof timed out. Check the connection and retry."
        : error.name === "AbortError"
          ? "Loading was cancelled."
          : error.message || "Failed to load payment proof.";
      setProofModal({ blobUrl: null, isPdf: false, loading: false, error: message, payment });
    } finally {
      clearTimeout(timeoutId);
      if (proofRequestRef.current?.requestId === requestId) {
        proofRequestRef.current = null;
      }
    }
  }, []);

  const closeProof = useCallback(() => {
    proofRequestRef.current?.controller.abort();
    proofRequestRef.current = null;
    if (proofBlobUrlRef.current) {
      URL.revokeObjectURL(proofBlobUrlRef.current);
      proofBlobUrlRef.current = null;
    }
    setProofModal(null);
  }, []);

  useEffect(() => () => {
    proofRequestRef.current?.controller.abort();
    if (proofBlobUrlRef.current) URL.revokeObjectURL(proofBlobUrlRef.current);
  }, []);

  // Print receipt helper — uses shared receiptPrinter utility
  // cashParams = { cashReceived?: number, change?: number }
  const printReceipt = useCallback((data, payment, referenceNumber = "", cashParams = {}) => {
    const receiptNumber = data.receipt_number || data.receipt?.receipt_number || `REC-${payment.id}`;
    const amount = Number(data.amount || data.receipt?.total_amount || payment.amount || payment.total_amount || 0);
    const cashier = user?.name || "Cashier";
    const customer = payment.customer_name || payment.customer?.name || "Customer";
    const service = payment.service_name || payment.service?.name || payment.order_name || payment.request_type || payment.type || "Payment";
    const method = payment.payment_method || data.payment_method || "Online Payment";
    const refNum = referenceNumber || data.payment_reference || "";

    // Build items list — use actual items if available, otherwise single service line
    let items;
    const rawItems = data.receipt?.items || payment.items || [];
    if (rawItems.length > 0) {
      items = rawItems.map((item) => ({
        name: item.item_name || item.name || item.description || "Item",
        quantity: Number(item.quantity || 1),
        unitPrice: Number(item.unit_price || item.price || item.amount || 0),
        total: Number(item.total_price || item.total || item.amount || 0),
      }));
    } else {
      items = [{ name: service, quantity: 1, unitPrice: amount, total: amount }];
    }

    printReceiptUtil({
      title: "Invoice",
      receiptNumber,
      date: new Date().toLocaleString("en-PH"),
      cashier,
      customer,
      paymentMethod: method,
      paymentStatus: "paid",
      referenceNumber: refNum,
      verifiedBy: cashier,
      amountReceived: cashParams.cashReceived ?? undefined,
      change:         cashParams.change       ?? undefined,
      items,
      subtotal: amount,
      total: amount,
    });
  }, [user]);

  // Verify single payment
  // cashParams = { cashReceived?: number, change?: number }
  const verifyPayment = useCallback(async (payment, referenceNumber = "", cashParams = {}) => {
    const confirmed = await showConfirm(
      `Verify payment of ₱${Number(payment.amount || payment.total_amount || 0).toLocaleString("en-PH")} from ${payment.customer_name || payment.customer?.name || "Customer"}?`
    );
    if (!confirmed) return;

    try {
      setActionLoading(`${paymentKey(payment)}-verify`);
      const data = await apiRequest(`/cashier/payment-requests/${payment.id}/verify`, "POST", {
        type: payment.payable_type || payment.type || payment.payment_source || "service_request",
        cashier_remarks: "Payment verified by cashier",
        reference_number: referenceNumber.trim(),
        payment_method: payment.payment_method || "counter",
        ...(cashParams.cashReceived != null ? { cash_received: cashParams.cashReceived } : {}),
        ...(cashParams.change       != null ? { change:         cashParams.change       } : {}),
      });

      if (data && data.success) {
        printReceipt(data, payment, referenceNumber, cashParams);
        await showSuccess(data.message || `Payment verified. Receipt: ${data.receipt_number || "Generated"}`);
        fetchRequests({ silent: true });
        return data;
      } else {
        showAlert(data?.message || "Failed to verify payment.");
        return data;
      }
    } catch (err) {
      console.error("Failed to verify payment:", err);
      if ((err?.message || "").toLowerCase().includes("only pending")) {
        showAlert("This payment was already processed. Refreshing the queue.");
        fetchRequests({ silent: true });
      } else {
        showError(err.message || "Failed to verify payment.");
      }
    } finally {
      setActionLoading(null);
    }
  }, [fetchRequests, printReceipt]);

  // Reject single payment — only a pending proof can be rejected; an
  // 'unpaid' record is awaiting payment, not approval, and an already
  // processed record is stale.
  const rejectPayment = useCallback(async (payment) => {
    if ((payment.payment_status || "").toLowerCase() !== "pending") {
      showAlert("Only payments with a submitted proof can be rejected.");
      return;
    }

    const cashier_remarks = await showReasonPrompt("Reason for rejecting this payment proof:", "Reject Payment", "Reject", PAYMENT_REJECT_REASONS);
    if (!cashier_remarks) return;

    try {
      setActionLoading(`${paymentKey(payment)}-reject`);
      const data = await apiRequest(`/cashier/payment-requests/${payment.id}/reject`, "POST", {
        type: payment.payable_type || payment.type || payment.payment_source || "service_request",
        cashier_remarks,
        rejection_reason: cashier_remarks,
      });

      if (data && data.success) {
        showSuccess(data.message || 'Payment rejected.');
        fetchRequests({ silent: true });
      } else {
        showAlert(data?.message || 'Failed to reject payment.');
      }
    } catch (err) {
      console.error("Failed to reject payment:", err);
      if ((err?.message || "").toLowerCase().includes("only pending")) {
        showAlert("This payment was already processed. Refreshing the queue.");
        fetchRequests({ silent: true });
      } else {
        showError(err.message || "Failed to reject payment.");
      }
    } finally {
      setActionLoading(null);
    }
  }, [fetchRequests]);

  // Bulk verify
  const bulkVerify = useCallback(async () => {
    if (selectedIds.length === 0) return;
    
    const confirmed = await showConfirm(
      `Verify ${selectedIds.length} payment${selectedIds.length > 1 ? 's' : ''}?`
    );
    if (!confirmed) return;

    let successCount = 0;
    for (const id of selectedIds) {
      try {
        const payment = requests.find(r => paymentKey(r) === id);
        // 'pending' (proof submitted) and 'unpaid' (counter collection) are
        // the only actionable states — skip stale/already-processed rows.
        if (!payment || !["pending", "unpaid"].includes((payment.payment_status || "").toLowerCase())) continue;

        const data = await apiRequest(`/cashier/payment-requests/${payment.id}/verify`, "POST", {
          type: payment.payable_type || payment.type || payment.payment_source || "service_request",
          cashier_remarks: "Payment verified by cashier (bulk)",
        });
        
        if (data?.success) successCount++;
      } catch (err) {
        console.error(`Failed to verify payment ${id}:`, err);
      }
    }
    
    showSuccess(`${successCount} of ${selectedIds.length} payments verified.`);
    setSelectedIds([]);
    fetchRequests({ silent: true });
  }, [selectedIds, requests, fetchRequests]);

  // Bulk reject — only pending proofs are rejectable
  const bulkReject = useCallback(async () => {
    const pendingIds = selectedIds.filter((id) => {
      const payment = requests.find((r) => paymentKey(r) === id);
      return (payment?.payment_status || "").toLowerCase() === "pending";
    });
    if (pendingIds.length === 0) {
      showAlert("Only payments with a submitted proof can be rejected.");
      return;
    }

    const cashier_remarks = await showReasonPrompt(`Reason for rejecting ${pendingIds.length} payment${pendingIds.length > 1 ? 's' : ''}:`, "Reject Payments", "Reject", PAYMENT_REJECT_REASONS);
    if (!cashier_remarks) return;

    let successCount = 0;
    for (const id of pendingIds) {
      try {
        const payment = requests.find(r => paymentKey(r) === id);
        if (!payment) continue;

        const data = await apiRequest(`/cashier/payment-requests/${payment.id}/reject`, "POST", {
          type: payment.payable_type || payment.type || payment.payment_source || "service_request",
          cashier_remarks,
          rejection_reason: cashier_remarks,
        });
        
        if (data?.success) successCount++;
      } catch (err) {
        console.error(`Failed to reject payment ${id}:`, err);
      }
    }
    
    showSuccess(`${successCount} of ${selectedIds.length} payments rejected.`);
    setSelectedIds([]);
    fetchRequests({ silent: true });
  }, [selectedIds, requests, fetchRequests]);

  // Filtered and sorted requests - MUST be defined before callbacks that use it
  const filteredRequests = useMemo(() => {
    let filtered = requests.filter((item) => {
      const matchesSearch = !searchTerm ||
        (item.customer_name || item.customer?.name || "")
          .toLowerCase()
          .includes(searchTerm.toLowerCase());
      const matchesType = typeFilter === "all" ||
        (item.request_type || item.type || "").toLowerCase() === typeFilter.toLowerCase();
      const method = (item.payment_method || "").toLowerCase();
      const matchesMethod = methodFilter === "all" ||
        method === methodFilter.toLowerCase() ||
        (methodFilter === "cash" && (!method || method === "cash" || method === "counter"));
      return matchesSearch && matchesType && matchesMethod;
    });

    // Sort
    filtered.sort((a, b) => {
      switch (sortBy) {
        case "date-asc":
          return new Date(a.request_date || a.date) - new Date(b.request_date || b.date);
        case "date-desc":
          return new Date(b.request_date || b.date) - new Date(a.request_date || a.date);
        case "amount-asc":
          return (a.amount || a.total_amount || 0) - (b.amount || b.total_amount || 0);
        case "amount-desc":
          return (b.amount || b.total_amount || 0) - (a.amount || a.total_amount || 0);
        case "name-asc":
          return (a.customer_name || "").localeCompare(b.customer_name || "");
        case "name-desc":
          return (b.customer_name || "").localeCompare(a.customer_name || "");
        default:
          return 0;
      }
    });

    return filtered;
  }, [requests, searchTerm, typeFilter, methodFilter, sortBy]);

  // Selection handlers (now defined after filteredRequests)
  const toggleSelection = useCallback((id) => {
    setSelectedIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  }, []);

  const selectAll = useCallback(() => {
    const allSelected = filteredRequests.every(r => selectedIds.includes(paymentKey(r)));
    if (allSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredRequests.map(paymentKey));
    }
  }, [filteredRequests, selectedIds]);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
  }, []);

  // Export — supports CSV, Excel, and PDF via shared utilities
  const exportColumns = [
    { key: "request_date", label: "Date", format: "date" },
    { key: "customer_name", label: "Customer" },
    { key: "request_type", label: "Type" },
    { key: "service_name", label: "Service" },
    { key: "amount", label: "Amount", format: "currency" },
    { key: "payment_status", label: "Status" },
  ];

  const exportToCSV = useCallback((format = "csv") => {
    const data = filteredRequests;
    if (!data || data.length === 0) { showSuccess("No data to export"); return; }
    if (format === "csv") exportCSVUtil(data, exportColumns, "pending-payments");
    else if (format === "excel") exportToExcel(data, exportColumns, "pending-payments");
    else if (format === "pdf") exportToPDF(data, exportColumns, "Pending Payments Report", "pending-payments");
    showSuccess(`Exported ${data.length} records`);
  }, [filteredRequests]);

  // Stats
  const stats = useMemo(() => {
    const total = filteredRequests.length;
    const totalAmount = filteredRequests.reduce(
      (sum, item) => sum + Number(item.amount || item.total_amount || 0),
      0
    );
    const verifiedToday = requests.filter(r => {
      const verifiedAt = r.verified_at || r.paid_at || r.updated_at;
      if (!verifiedAt) return false;
      const date = new Date(verifiedAt);
      const today = new Date();
      const ps = r.payment_status || "";
      return date.toDateString() === today.toDateString() && (ps === "verified" || ps === "paid");
    }).length;
    
    return { total, totalAmount, verifiedToday };
  }, [filteredRequests, requests]);

  return {
    // Data
    requests,
    filteredRequests,
    loading,
    refreshing,
    actionLoading,
    lastUpdated,
    stats,
    
    // Filters
    searchTerm,
    setSearchTerm,
    typeFilter,
    setTypeFilter,
    methodFilter,
    setMethodFilter,
    sortBy,
    setSortBy,
    
    // Selection
    selectedIds,
    toggleSelection,
    selectAll,
    clearSelection,
    
    // Actions
    fetchRequests,
    verifyPayment,
    rejectPayment,
    bulkVerify,
    bulkReject,
    exportToCSV,
    
    // Proof modal
    proofModal,
    openProof,
    closeProof,
  };
};
