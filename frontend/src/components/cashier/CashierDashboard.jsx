import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, NavLink, useLocation } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faShoppingCart,
  faReceipt,
  faCalendarAlt,
  faCreditCard,
  faArrowUp,
  faMoneyBillWave,
  faChartLine,
  faClock,
  faWallet,
  faRotateRight,
  faTriangleExclamation,
  faCheckCircle,
  faCoins,
  faSearch,
  faBolt,
  faBoxOpen,
  faBarcode,
  faEdit,
  faPlus,
  faStar,
  faArrowRight,
  faChartBar,
  faList,
  faUserPlus,
  faUser,
} from "@fortawesome/free-solid-svg-icons";
import CashierSidebar from "./CashierSidebar";
import DashboardLayout from "../shared/DashboardLayout";
import "./CashierDashboard.css";
import { apiRequest } from "../../api/client";
import { formatCurrency } from "../../utils/currency";
import { useAuth } from "../../context/AuthContext";
import { showAlert, showSuccess, showError } from "../../utils/alert.jsx";
import { STORE_INFO } from "../../utils/storeInfo";
import { exportToCSV, exportToPDF, exportToExcel } from "../../utils/reportExport";

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const isGenericFetchFailure = (error) =>
  error?.name === "TypeError" && error?.message === "Failed to fetch";

const formatTime = (value) => {
  if (!value) return "Just now";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Just now";

  return date.toLocaleTimeString("en-PH", {
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatTypeLabel = (type) => {
  if (!type) return "Sale";
  return String(type)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const getTypeIcon = (type) => {
  const normalized = String(type || "").toLowerCase();

  if (normalized.includes("appointment")) return faCreditCard;
  if (normalized.includes("boarding")) return faCalendarAlt;
  if (normalized.includes("product")) return faShoppingCart;
  if (normalized.includes("cash")) return faMoneyBillWave;

  return faReceipt;
};

const CashierDashboard = () => {
  const { user, updateUser } = useAuth();
  const name = user?.name || "Cashier";
  const profilePhoto = user?.profile_photo || "";

  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [showEndShiftModal, setShowEndShiftModal] = useState(false);
  const [actualCashCount, setActualCashCount] = useState("");
  const [shiftNote, setShiftNote] = useState("");
  const [shiftMessage, setShiftMessage] = useState("");
  const [showProductSearch, setShowProductSearch] = useState(false);
  const [productSearchQuery, setProductSearchQuery] = useState("");
  const [productSearchResults, setProductSearchResults] = useState([]);
  const [productSearchLoading, setProductSearchLoading] = useState(false);
  const [showCustomerSearch, setShowCustomerSearch] = useState(false);
  const [customerSearchQuery, setCustomerSearchQuery] = useState("");
  const [customerSearchResults, setCustomerSearchResults] = useState([]);
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false);
  const [lowStockItems, setLowStockItems] = useState([]);
  const [salesTarget, setSalesTarget] = useState(50000);
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [refundTransactionId, setRefundTransactionId] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundMessage, setRefundMessage] = useState("");
  const [showMultiPaymentModal, setShowMultiPaymentModal] = useState(false);
  const [multiPaymentTotal, setMultiPaymentTotal] = useState("");
  const [cashAmount, setCashAmount] = useState("");
  const [cardAmount, setCardAmount] = useState("");
  const [multiPaymentMessage, setMultiPaymentMessage] = useState("");
  const [showDiscountModal, setShowDiscountModal] = useState(false);
  const [discountCode, setDiscountCode] = useState("");
  const [discountMessage, setDiscountMessage] = useState("");
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [receiptTransactionId, setReceiptTransactionId] = useState("");
  const [breakStartTime, setBreakStartTime] = useState(null);
  const [breakDuration, setBreakDuration] = useState(0);
  const [showHandoverModal, setShowHandoverModal] = useState(false);
  const [handoverNote, setHandoverNote] = useState("");
  const [lastHandover, setLastHandover] = useState(null);
  const [showExportDropdown, setShowExportDropdown] = useState(false);
  const [lastShiftReport, setLastShiftReport] = useState(null);
  const [topSellingProducts, setTopSellingProducts] = useState([]);
  const [showPurchaseHistoryModal, setShowPurchaseHistoryModal] = useState(false);
  const [purchaseHistoryCustomerId, setPurchaseHistoryCustomerId] = useState("");
  const [purchaseHistoryData, setPurchaseHistoryData] = useState(null);
  const [purchaseHistoryLoading, setPurchaseHistoryLoading] = useState(false);
  const [barcodeInput, setBarcodeInput] = useState("");
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterPaymentType, setFilterPaymentType] = useState("");
  const [showNotesModal, setShowNotesModal] = useState(false);
  const [cashierNotes, setCashierNotes] = useState("");
  const [pendingOrders, setPendingOrders] = useState([]);
  const [showPriceOverrideModal, setShowPriceOverrideModal] = useState(false);
  const [priceOverrideProductId, setPriceOverrideProductId] = useState("");
  const [priceOverrideOriginal, setPriceOverrideOriginal] = useState("");
  const [priceOverrideNew, setPriceOverrideNew] = useState("");
  const [cartItems, setCartItems] = useState([]);
  const [customerLoyaltyPoints, setCustomerLoyaltyPoints] = useState(0);
  const [cashDrawerOpen, setCashDrawerOpen] = useState(false);
  const [showVoidModal, setShowVoidModal] = useState(false);
  const [voidTransactionId, setVoidTransactionId] = useState("");
  const [voidReason, setVoidReason] = useState("");
  const [showCustomerRegModal, setShowCustomerRegModal] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [newCustomerEmail, setNewCustomerEmail] = useState("");
  const [taxRate, setTaxRate] = useState(0.12);
  const [tipAmount, setTipAmount] = useState("");
  const [showGiftCardModal, setShowGiftCardModal] = useState(false);
  const [giftCardNumber, setGiftCardNumber] = useState("");
  const [giftCardBalance, setGiftCardBalance] = useState(null);
  const [pendingBoardings, setPendingBoardings] = useState([]);
  const [pendingAppointments, setPendingAppointments] = useState([]);

  const location = useLocation();

  const normalizedPath = location.pathname.replace(/\/+$/, "");
  const showOverview = normalizedPath === "/cashier" || normalizedPath === "/cashier/dashboard";

  const greeting = useMemo(() => {
    const hour = new Date().getHours();

    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  }, []);

  const fetchDashboardData = useCallback(
    async ({ silent = false } = {}) => {
      if (!showOverview) return;

      try {
        if (silent) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }

        const data = await apiRequest("/cashier/dashboard");
        setDashboardData(data || {});
        setLowStockItems(data.low_stock_items || []);
        setTopSellingProducts(data.top_selling_products || []);
        setPendingOrders(data.pending_orders || []);
        setPendingBoardings(data.pending_boardings || []);
        setPendingAppointments(data.pending_appointments || []);
        setError("");
      } catch (err) {
        setError(err.message || "Failed to load dashboard data");
        showError(err.message || "Failed to load dashboard data");
        if (!isGenericFetchFailure(err)) {
          console.error("Cashier dashboard fetch error:", err);
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [showOverview]
  );

  const fetchLastCashierInfo = useCallback(async () => {
    try {
      const [handoverRes, shiftRes] = await Promise.all([
        apiRequest("/cashier/handover/last"),
        apiRequest("/cashier/shift-report/last"),
      ]);
      setLastHandover(handoverRes?.handover || null);
      setLastShiftReport(shiftRes?.shift_report || null);
    } catch (err) {
      if (!isGenericFetchFailure(err)) {
        console.error("Failed to load last cashier info:", err);
      }
    }
  }, []);

  useEffect(() => {
    fetchDashboardData();
    fetchLastCashierInfo();
  }, [fetchDashboardData, fetchLastCashierInfo]);

  const todaySales = toNumber(dashboardData?.today_sales);
  const todayTransactions = toNumber(dashboardData?.today_transactions);
  const monthlySales = toNumber(dashboardData?.monthly_sales);
  const monthlyTransactions = toNumber(dashboardData?.monthly_transactions);
  const pendingPayments = toNumber(dashboardData?.pending_payments);

  const cashCollected = toNumber(
    dashboardData?.cash_collected ||
      dashboardData?.cash_sales ||
      dashboardData?.payment_breakdown?.cash ||
      todaySales
  );

  const expectedCash = cashCollected;

  const actualCash = toNumber(actualCashCount);

  const cashDifference = actualCashCount
    ? actualCash - expectedCash
    : 0;

  const averageOrder =
    todaySales > 0 && todayTransactions > 0
      ? todaySales / todayTransactions
      : 0;

  const summaryCards = useMemo(
    () => [
      {
        title: "Today's Sales",
        value: formatCurrency(todaySales),
        subtitle: "Total revenue processed today",
        icon: faMoneyBillWave,
        tone: "pink",
        change: todayTransactions > 0 ? `${todayTransactions} transaction(s)` : "No sales yet",
      },
      {
        title: "Transactions",
        value: todayTransactions,
        subtitle: "Completed sales today",
        icon: faReceipt,
        tone: "purple",
        change: "Live cashier activity",
      },
      {
        title: "Monthly Sales",
        value: formatCurrency(monthlySales),
        subtitle: "Total sales this month",
        icon: faChartLine,
        tone: "blue",
        change: `${monthlyTransactions} monthly transaction(s)`,
      },
      {
        title: "Pending Payments",
        value: pendingPayments,
        subtitle: "Awaiting payment completion",
        icon: faClock,
        tone: "orange",
        change: pendingPayments > 0 ? "Needs attention" : "All clear",
      },
    ],
    [todaySales, todayTransactions, monthlySales, monthlyTransactions, pendingPayments]
  );

  const recentTransactions = useMemo(() => {
    const sales = dashboardData?.recent_sales || [];

    return sales.map((sale) => ({
      id: `TRX-${String(sale.id || "0").padStart(3, "0")}`,
      customer:
        sale.type === "appointment"
          ? "Appointment Payment"
          : sale.type === "boarding"
          ? "Boarding Payment"
          : sale.type === "product"
          ? "Product Sale"
          : formatTypeLabel(sale.type),
      amount: formatCurrency(toNumber(sale.amount)),
      items: sale.items || 1,
      payment: formatTypeLabel(sale.type || "Cash"),
      time: formatTime(sale.created_at),
      status: sale.status || "completed",
      icon: getTypeIcon(sale.type),
    }));
  }, [dashboardData]);

  const getTransactionProgress = (status) => {
    const steps = [
      { key: "pending", label: "Pending" },
      { key: "processing", label: "Processing" },
      { key: "completed", label: "Completed" },
    ];

    const statusMap = {
      pending: 0,
      processing: 1,
      completed: 2,
      cancelled: -1,
      canceled: -1,
    };

    const currentIndex = statusMap[status?.toLowerCase()] || 2;

    return steps.map((step, index) => ({
      ...step,
      active: index <= currentIndex,
      current: index === currentIndex,
    }));
  };

  const salesByType = useMemo(() => dashboardData?.sales_by_type || [], [dashboardData]);

  const maxSalesTypeTotal = useMemo(() => {
    const totals = salesByType.map((item) => toNumber(item.total));
    return Math.max(...totals, 1);
  }, [salesByType]);

  const quickActions = [
    { label: "New Sale", icon: faShoppingCart, link: "/cashier/pos", tone: "pink" },
    { label: "Sales History", icon: faUserPlus, link: "/cashier/history", tone: "soft" },
    { label: "View Transactions", icon: faList, link: "/cashier/transactions", tone: "success" },
    { label: "View Reports", icon: faChartBar, link: "/cashier/reports", tone: "gold" },
  ];

  const cashierDashboardClasses = [
    "app-dashboard",
    "cashier-dashboard",
    ...(normalizedPath === "/cashier/dashboard/pos" ? [] : ["cashier-workspace"]),
  ]
    .join(" ");

  const handleEndShift = async () => {
    if (!actualCashCount) {
      setShiftMessage("Please enter actual cash count.");
      return;
    }

    const shiftReport = {
      cashier_name: name,
      shift_date: new Date().toISOString(),
      total_sales: todaySales,
      total_transactions: todayTransactions,
      cash_collected: cashCollected,
      expected_cash: expectedCash,
      actual_cash: actualCash,
      cash_difference: cashDifference,
      note: shiftNote,
    };

    try {
      try {
        await apiRequest("/cashier/end-shift", {
          method: "POST",
          body: JSON.stringify(shiftReport),
        });
      } catch {
        const savedReports = JSON.parse(
          localStorage.getItem("cashierShiftReports") || "[]"
        );

        localStorage.setItem(
          "cashierShiftReports",
          JSON.stringify([shiftReport, ...savedReports])
        );
      }

      setShiftMessage("Shift report submitted successfully.");
      setActualCashCount("");
      setShiftNote("");
      fetchLastCashierInfo();

      setTimeout(() => {
        setShowEndShiftModal(false);
        setShiftMessage("");
      }, 1200);
    } catch (err) {
      setShiftMessage(err.message || "Failed to submit shift report.");
    }
  };

  const handleProductSearch = async (query) => {
    if (!query.trim()) {
      setProductSearchResults([]);
      return;
    }

    setProductSearchLoading(true);
    try {
      const data = await apiRequest(`/products/search?q=${encodeURIComponent(query)}`);
      setProductSearchResults(Array.isArray(data) ? data : data.products || []);
    } catch (err) {
      console.error("Product search error:", err);
      setProductSearchResults([]);
    } finally {
      setProductSearchLoading(false);
    }
  };

  const handleCustomerSearch = async (query) => {
    if (!query.trim()) {
      setCustomerSearchResults([]);
      return;
    }

    setCustomerSearchLoading(true);
    try {
      const data = await apiRequest(`/customers/search?q=${encodeURIComponent(query)}`);
      setCustomerSearchResults(Array.isArray(data) ? data : data.customers || []);
    } catch (err) {
      console.error("Customer search error:", err);
      setCustomerSearchResults([]);
    } finally {
      setCustomerSearchLoading(false);
    }
  };

  const exportColumns = [
    { key: "id", label: "ID" },
    { key: "type", label: "Type" },
    { key: "amount", label: "Amount" },
    { key: "items", label: "Items" },
    { key: "created_at", label: "Date" },
  ];

  const handleExportTransactions = (format) => {
    setShowExportDropdown(false);
    const transactions = dashboardData?.recent_sales || [];
    if (transactions.length === 0) {
      showAlert("No transactions to export");
      return;
    }

    const rows = transactions.map((t) => ({
      id: `TRX-${String(t.id || "0").padStart(3, "0")}`,
      type: t.type || 'Sale',
      amount: toNumber(t.amount),
      items: t.items || 1,
      created_at: t.created_at || new Date().toISOString(),
    }));

    const filename = `transactions_${new Date().toISOString().split('T')[0]}`;

    if (format === "csv") {
      exportToCSV(rows, exportColumns, filename);
    } else if (format === "excel") {
      exportToExcel(rows, exportColumns, filename);
    } else if (format === "pdf") {
      exportToPDF(rows, exportColumns, "Transactions", filename);
    }
  };

  const handleRefund = async () => {
    if (!refundTransactionId || !refundAmount || !refundReason) {
      setRefundMessage("Please fill in all required fields.");
      return;
    }

    const refundData = {
      transaction_id: refundTransactionId,
      refund_amount: toNumber(refundAmount),
      reason: refundReason,
      cashier_name: name,
    };

    try {
      await apiRequest("/cashier/refund", {
        method: "POST",
        body: JSON.stringify(refundData),
      });

      setRefundMessage("Refund processed successfully.");
      setRefundTransactionId("");
      setRefundAmount("");
      setRefundReason("");

      setTimeout(() => {
        setShowRefundModal(false);
        setRefundMessage("");
        fetchDashboardData({ silent: true });
      }, 1200);
    } catch (err) {
      setRefundMessage(err.message || "Failed to process refund.");
    }
  };

  const handleMultiPayment = async () => {
    const total = toNumber(multiPaymentTotal);
    const cash = toNumber(cashAmount);
    const card = toNumber(cardAmount);

    if (!total || !cash || !card) {
      setMultiPaymentMessage("Please fill in all payment amounts.");
      return;
    }

    if (cash + card !== total) {
      setMultiPaymentMessage(`Cash + Card must equal Total (${formatCurrency(total)}).`);
      return;
    }

    const paymentData = {
      total_amount: total,
      cash_amount: cash,
      card_amount: card,
      cashier_name: name,
    };

    try {
      await apiRequest("/cashier/multi-payment", {
        method: "POST",
        body: JSON.stringify(paymentData),
      });

      setMultiPaymentMessage("Multi-payment processed successfully.");
      setMultiPaymentTotal("");
      setCashAmount("");
      setCardAmount("");

      setTimeout(() => {
        setShowMultiPaymentModal(false);
        setMultiPaymentMessage("");
        fetchDashboardData({ silent: true });
      }, 1200);
    } catch (err) {
      setMultiPaymentMessage(err.message || "Failed to process multi-payment.");
    }
  };

  const handleApplyDiscount = async () => {
    if (!discountCode.trim()) {
      setDiscountMessage("Please enter a discount code.");
      return;
    }

    try {
      const data = await apiRequest("/cashier/apply-discount", {
        method: "POST",
        body: JSON.stringify({ code: discountCode }),
      });

      setDiscountMessage(`Discount applied: ${data.discount_percent || data.discount_amount}% off`);
      setDiscountCode("");

      setTimeout(() => {
        setShowDiscountModal(false);
        setDiscountMessage("");
      }, 1500);
    } catch (err) {
      setDiscountMessage(err.message || "Invalid discount code.");
    }
  };

  const handleGenerateReceipt = async () => {
    if (!receiptTransactionId) {
      showAlert("Please enter a transaction ID");
      return;
    }

    try {
      const data = await apiRequest(`/cashier/receipt/${receiptTransactionId}`);
      
      const receiptContent = `
${STORE_INFO.name}
SALES INVOICE
=====================
Receipt #${receiptTransactionId}
Date: ${new Date().toLocaleString()}
Cashier: ${name}
---------------------
${data.items?.map(item => `${item.name} x${item.qty} - ${formatCurrency(item.price)}`).join('\n') || 'Items: N/A'}
---------------------
Subtotal (incl. VAT): ${formatCurrency(data.subtotal ?? data.total ?? 0)}
Net Amount (ex-VAT): ${formatCurrency(data.net_amount ?? 0)}
VAT (12%): ${formatCurrency(data.vat_amount ?? 0)}
Discount: ${formatCurrency(data.discount || 0)}
Total: ${formatCurrency(data.total || 0)}
---------------------
Thank you for choosing Pawesome!
      `.trim();

      const blob = new Blob([receiptContent], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `receipt_${receiptTransactionId}.txt`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setShowReceiptModal(false);
      setReceiptTransactionId("");
    } catch (err) {
      showError("Failed to generate receipt: " + (err.message || "Unknown error"));
    }
  };

  const handleStartBreak = () => {
    setBreakStartTime(new Date());
    setBreakDuration(0);
  };

  const handleEndBreak = () => {
    if (breakStartTime) {
      const duration = Math.floor((new Date() - breakStartTime) / 1000 / 60);
      setBreakDuration(duration);
      setBreakStartTime(null);
    }
  };

  const handleHandover = async () => {
    if (!handoverNote.trim()) {
      showAlert("Please add a handover note");
      return;
    }

    const handoverData = {
      cashier_name: name,
      note: handoverNote,
      shift_date: new Date().toISOString(),
    };

    try {
      await apiRequest("/cashier/handover", {
        method: "POST",
        body: JSON.stringify(handoverData),
      });

      showSuccess("Handover note saved successfully.");
      setHandoverNote("");
      setShowHandoverModal(false);
      fetchLastCashierInfo();
    } catch (err) {
      showError("Failed to save handover: " + (err.message || "Unknown error"));
    }
  };

  const handleFetchPurchaseHistory = async () => {
    if (!purchaseHistoryCustomerId.trim()) {
      showAlert("Please enter a customer ID");
      return;
    }

    setPurchaseHistoryLoading(true);
    try {
      const data = await apiRequest(`/customers/${purchaseHistoryCustomerId}/purchases`);
      setPurchaseHistoryData(data);
    } catch (err) {
      showError("Failed to fetch purchase history: " + (err.message || "Unknown error"));
      setPurchaseHistoryData(null);
    } finally {
      setPurchaseHistoryLoading(false);
    }
  };

  const handleBarcodeScan = async () => {
    if (!barcodeInput.trim()) return;

    try {
      const data = await apiRequest(`/products/barcode/${barcodeInput}`);
      const item = data?.item ?? data?.product ?? null;
      if (item) {
        setShowProductSearch(true);
        setProductSearchQuery(item.name);
        setProductSearchResults([item]);
      } else {
        showAlert("Product not found for this barcode");
      }
      setBarcodeInput("");
    } catch (err) {
      showError("Failed to scan barcode: " + (err.message || "Unknown error"));
    }
  };

  const handleApplyFilters = () => {
    const filters = {};
    if (filterDateFrom) filters.date_from = filterDateFrom;
    if (filterDateTo) filters.date_to = filterDateTo;
    if (filterPaymentType) filters.payment_type = filterPaymentType;

    setShowFilterModal(false);
    fetchDashboardData({ silent: true });
  };

  const handleSaveNotes = () => {
    localStorage.setItem("cashier_notes", cashierNotes);
    showSuccess("Notes saved successfully!");
    setShowNotesModal(false);
  };

  const handlePriceOverride = () => {
    if (!priceOverrideNew || toNumber(priceOverrideNew) <= 0) {
      showAlert("Please enter a valid price.");
      return;
    }

    showSuccess(`Price overridden from ${formatCurrency(priceOverrideOriginal)} to ${formatCurrency(priceOverrideNew)}`);
    setShowPriceOverrideModal(false);
    setPriceOverrideProductId("");
    setPriceOverrideOriginal("");
    setPriceOverrideNew("");
  };

  const handleAddToCart = (product) => {
    const existingItem = cartItems.find((item) => item.id === product.id);
    if (existingItem) {
      setCartItems(
        cartItems.map((item) =>
          item.id === product.id
            ? { ...item, quantity: item.quantity + 1 }
            : item
        )
      );
    } else {
      setCartItems([...cartItems, { ...product, quantity: 1 }]);
    }
    showSuccess(`${product.name} added to cart`);
  };

  const handleSelectCustomer = (customer) => {
    setPurchaseHistoryCustomerId(String(customer?.id || ""));
    setCustomerLoyaltyPoints(toNumber(customer?.loyalty_points));
    setShowCustomerSearch(false);
    setCustomerSearchQuery("");
    setCustomerSearchResults([]);
    showSuccess(`Selected customer: ${customer?.name || "Customer"}`);
  };

  const handleOpenPriceOverride = (product) => {
    setPriceOverrideProductId(product.id);
    setPriceOverrideOriginal(product.price);
    setPriceOverrideNew(product.price);
    setShowPriceOverrideModal(true);
  };

  const handleToggleCashDrawer = () => {
    setCashDrawerOpen(!cashDrawerOpen);
    showAlert(cashDrawerOpen ? "Cash drawer closed" : "Cash drawer opened");
  };

  const handleVoidTransaction = async () => {
    if (!voidTransactionId || !voidReason.trim()) {
      showAlert("Please fill in all required fields.");
      return;
    }

    const voidData = {
      transaction_id: voidTransactionId,
      reason: voidReason,
      cashier_name: name,
    };

    try {
      await apiRequest("/cashier/void", {
        method: "POST",
        body: JSON.stringify(voidData),
      });

      showSuccess("Transaction voided successfully.");
      setVoidTransactionId("");
      setVoidReason("");
      setShowVoidModal(false);
      fetchDashboardData({ silent: true });
    } catch (err) {
      showError("Failed to void transaction: " + (err.message || "Unknown error"));
    }
  };

  const handleRegisterCustomer = async () => {
    if (!newCustomerName.trim() || !newCustomerPhone.trim()) {
      showAlert("Please fill in name and phone number.");
      return;
    }

    const customerData = {
      name: newCustomerName,
      phone: newCustomerPhone,
      email: newCustomerEmail,
    };

    try {
      await apiRequest("/customers", {
        method: "POST",
        body: JSON.stringify(customerData),
      });

      showSuccess("Customer registered successfully.");
      setNewCustomerName("");
      setNewCustomerPhone("");
      setNewCustomerEmail("");
      setShowCustomerRegModal(false);
    } catch (err) {
      showError("Failed to register customer: " + (err.message || "Unknown error"));
    }
  };

  const handleCheckGiftCardBalance = async () => {
    if (!giftCardNumber.trim()) {
      showAlert("Please enter a gift card number.");
      return;
    }

    try {
      const data = await apiRequest(`/gift-cards/${giftCardNumber}/balance`);
      setGiftCardBalance(data.balance);
    } catch (err) {
      showError("Failed to check gift card balance: " + (err.message || "Unknown error"));
      setGiftCardBalance(null);
    }
  };

  const handleMarkBoardingAsPaid = async (id) => {
    try {
      await apiRequest(`/cashier/boarding-payments/${id}/verify`, "POST");
      showSuccess("Payment confirmed successfully.");
      fetchDashboardData({ silent: true });
    } catch (err) {
      showError("Failed to confirm payment: " + (err.message || "Unknown error"));
    }
  };

  const handleMarkAppointmentAsPaid = async (id) => {
    try {
      await apiRequest(`/appointments/${id}/pay`, "POST");
      showSuccess("Payment confirmed successfully.");
      fetchDashboardData({ silent: true });
    } catch (err) {
      showError("Failed to confirm payment: " + (err.message || "Unknown error"));
    }
  };

  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      if (productSearchQuery) {
        handleProductSearch(productSearchQuery);
      }
    }, 300);

    return () => clearTimeout(debounceTimer);
  }, [productSearchQuery]);

  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      if (customerSearchQuery) {
        handleCustomerSearch(customerSearchQuery);
      }
    }, 300);

    return () => clearTimeout(debounceTimer);
  }, [customerSearchQuery]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.ctrlKey || event.metaKey) {
        switch (event.key.toLowerCase()) {
          case 'k':
            event.preventDefault();
            if (event.shiftKey) {
              setShowCustomerSearch(true);
            } else {
              setShowProductSearch(true);
            }
            break;
          case 'r':
            event.preventDefault();
            if (showOverview) {
              fetchDashboardData({ silent: true });
            }
            break;
          default:
            break;
        }
      } else if (event.key === 'F1') {
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showOverview, fetchDashboardData]);

  const extraActions = (
    <>
      <button
        className="btn-secondary"
        type="button"
        onClick={() => fetchDashboardData({ silent: true })}
        title="Refresh"
      >
        <FontAwesomeIcon
          icon={faRotateRight}
          className={refreshing ? "spin-icon" : ""}
        />
      </button>
    </>
  );

  const ROUTE_META = [
    { path: "/cashier", title: "Cashier Dashboard", subtitle: `${greeting}, ${name}. Process transactions and manage cashier sales.` },
    { path: "/cashier/dashboard", title: "Cashier Dashboard", subtitle: `${greeting}, ${name}. Process transactions and manage cashier sales.` },
    { path: "/cashier/dashboard/pos", title: "Point of Sale", subtitle: "Scan products, apply discounts, and process customer payments." },
    { path: "/cashier/dashboard/sales", title: "Sales & Transactions", subtitle: "Review completed sales, refunds, and payment methods." },
    { path: "/cashier/dashboard/transactions", title: "Sales & Transactions", subtitle: "Review completed sales, refunds, and payment methods." },
    { path: "/cashier/dashboard/history", title: "Sales History", subtitle: "Browse past transactions and generate receipts." },
    { path: "/cashier/dashboard/analytics", title: "Sales Analytics", subtitle: "Visualize revenue trends, peak hours, and product performance." },
    { path: "/cashier/dashboard/reports", title: "Sales Analytics", subtitle: "Visualize revenue trends, peak hours, and product performance." },
    { path: "/cashier/dashboard/profile", title: "Profile Settings", subtitle: "Manage your account details and preferences." },
    { path: "/cashier/transactions", title: "Sales & Transactions", subtitle: "Review completed sales, refunds, and payment methods." },
    { path: "/cashier/history", title: "Sales History", subtitle: "Browse past transactions and generate receipts." },
    { path: "/cashier/reports", title: "Sales Analytics", subtitle: "Visualize revenue trends, peak hours, and product performance." },
    { path: "/cashier/profile", title: "Profile Settings", subtitle: "Manage your account details and preferences." },
  ];

  const pageMeta = ROUTE_META.find((r) => r.path === normalizedPath) || ROUTE_META[0];

  return (
    <DashboardLayout
      sidebar={<CashierSidebar />}
      title={pageMeta.title}
      subtitle={pageMeta.subtitle}
      role="cashier"
      name={name}
      profilePhoto={profilePhoto}
      extraActions={extraActions}
      showChatbot
      chatbotTitle="Cashier Assistant"
      chatbotSubtitle="Transactions, payments, and cashier workflow help"
      className={cashierDashboardClasses}
    >

        <section className="app-content">
          {showOverview ? (
            <>
              {loading ? (
                <div className="premium-card fade-up">
                  <h2 className="premium-title">Loading cashier dashboard...</h2>
                  <p className="premium-muted">Please wait while the latest cashier records are being prepared.</p>
                </div>
              ) : error ? (
                <div className="premium-card fade-up">
                  <span className="state-icon">
                    <FontAwesomeIcon icon={faTriangleExclamation} />
                  </span>
                  <h2 className="premium-title">Unable to load dashboard</h2>
                  <p className="premium-muted">{error}</p>
                  <button
                    onClick={() => fetchDashboardData()}
                    className="btn-primary"
                    type="button"
                  >
                    <FontAwesomeIcon icon={faRotateRight} />
                    Retry
                  </button>
                </div>
              ) : (
                <>
                <section className="cashier-kpi-grid">
                  {summaryCards.map((card) => (
                    <div key={card.title} className={`cashier-kpi-card cashier-kpi-card--${card.tone || "pink"}`}>
                      <div className="cashier-kpi-card-icon"><FontAwesomeIcon icon={card.icon} /></div>
                      <h3>{card.value}</h3>
                      <p>{card.title}</p>
                      <small>{card.change}</small>
                    </div>
                  ))}
                </section>

                <section className="quick-actions-section">
                  <div className="quick-actions-grid">
                    {quickActions.map((action) => (
                      <NavLink key={action.label} to={action.link} className={`quick-action-card ${action.tone}`}>
                        <div className="quick-action-icon">
                          <FontAwesomeIcon icon={action.icon} />
                        </div>
                        <span>{action.label}</span>
                        <span className="action-arrow"><FontAwesomeIcon icon={faArrowRight} /></span>
                      </NavLink>
                    ))}
                  </div>
                </section>

                <section className="cashier-main-grid">
                  <div className="cashier-panel">
                    <div className="cashier-panel-header">
                      <div>
                        <h2>Recent Transactions</h2>
                        <p>Latest sales and payment records</p>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ position: "relative" }}>
                          <button className="btn-secondary" type="button" onClick={() => setShowExportDropdown(!showExportDropdown)}>
                            Export ▼
                          </button>
                          {showExportDropdown && (
                            <>
                              <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }} onClick={() => setShowExportDropdown(false)} />
                              <div style={{ position: "absolute", top: "100%", right: 0, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 999, minWidth: 160, overflow: "hidden" }}>
                                <button className="btn-secondary" type="button" style={{ width: "100%", border: "none", background: "#fff", textAlign: "left", padding: "10px 14px" }} onClick={() => handleExportTransactions("csv")}>Export as CSV</button>
                                <button className="btn-secondary" type="button" style={{ width: "100%", border: "none", background: "#fff", textAlign: "left", padding: "10px 14px" }} onClick={() => handleExportTransactions("excel")}>Export as Excel</button>
                                <button className="btn-secondary" type="button" style={{ width: "100%", border: "none", background: "#fff", textAlign: "left", padding: "10px 14px" }} onClick={() => handleExportTransactions("pdf")}>Export as PDF</button>
                              </div>
                            </>
                          )}
                        </div>
                        <span className="badge badge-success">Today</span>
                      </div>
                    </div>

                    {recentTransactions.length > 0 ? (
                      <div className="cashier-list">
                        {recentTransactions.map((transaction) => (
                          <div key={transaction.id} className="cashier-transaction-item">
                            <div>
                              <strong>{transaction.id}</strong>
                              <p>{transaction.customer}</p>
                            </div>

                            <div>
                              <strong>{transaction.amount}</strong>
                              <span className="badge badge-success">{transaction.status}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="cashier-empty-state">
                        <h3>No transactions yet</h3>
                        <p>Completed cashier transactions will appear here.</p>
                      </div>
                    )}
                  </div>

                  <aside className="cashier-side-stack">
                    <div className="cashier-panel">
                      <h2>Shift Summary</h2>
                      <div className="cashier-mini-stat">
                        <span>Cash Collected</span>
                        <strong>{formatCurrency(cashCollected)}</strong>
                      </div>
                      <div className="cashier-mini-stat">
                        <span>Transactions</span>
                        <strong>{todayTransactions}</strong>
                      </div>
                      {lastShiftReport && (
                        <div className="cashier-mini-stat" style={{ marginTop: 8 }}>
                          <span>Last Shift</span>
                          <strong style={{ fontSize: 12 }}>
                            {lastShiftReport.created_at
                              ? new Date(lastShiftReport.created_at).toLocaleDateString("en-PH")
                              : "N/A"}
                          </strong>
                        </div>
                      )}
                      {lastHandover && (
                        <div className="cashier-mini-stat" style={{ marginTop: 4 }}>
                          <span>Last Handover</span>
                          <strong style={{ fontSize: 12 }}>
                            {lastHandover.created_at
                              ? new Date(lastHandover.created_at).toLocaleDateString("en-PH")
                              : "N/A"}
                          </strong>
                        </div>
                      )}
                      <button className="btn-primary" onClick={() => setShowEndShiftModal(true)}>
                        End Shift
                      </button>
                    </div>

                    <div className="cashier-panel">
                      <h2>Sales Target</h2>
                      <strong>{Math.round((todaySales / salesTarget) * 100)}%</strong>
                      <div className="cashier-progress">
                        <span style={{ width: `${Math.min((todaySales / salesTarget) * 100, 100)}%` }} />
                      </div>
                      <p>{formatCurrency(salesTarget - todaySales)} remaining</p>
                    </div>
                  </aside>
                </section>
                </>
              )}
            </>
          ) : (
              <section className="dashboard-content">
                <Outlet />
              </section>
            )}
        </section>

        {showEndShiftModal && (
          <div className="app-modal-overlay">
            <div className="app-modal">
              <div className="app-modal-header">
                <h2 className="premium-title">Cashier Shift Report</h2>
                <button
                  type="button"
                  className="app-modal-close"
                  onClick={() => setShowEndShiftModal(false)}
                >
                  &times;
                </button>
              </div>

              <div className="app-grid-2">
                <div className="app-stat-card">
                  <p className="premium-muted">Total Sales</p>
                  <h3 className="premium-title">{formatCurrency(todaySales)}</h3>
                </div>

                <div className="app-stat-card">
                  <p className="premium-muted">Total Transactions</p>
                  <h3 className="premium-title">{todayTransactions}</h3>
                </div>

                <div className="app-stat-card">
                  <p className="premium-muted">Expected Cash</p>
                  <h3 className="premium-title">{formatCurrency(expectedCash)}</h3>
                </div>

                <div className="app-stat-card">
                  <p className="premium-muted">Actual Cash</p>
                  <h3 className="premium-title">
                    {actualCashCount ? formatCurrency(actualCash) : "Not counted"}
                  </h3>
                </div>
              </div>

              <div style={{ marginTop: "22px" }}>
                <label className="premium-muted">Actual Cash Count</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Enter actual cash in drawer"
                  value={actualCashCount}
                  onChange={(event) => setActualCashCount(event.target.value)}
                />
              </div>

              <div
                className="premium-card"
                style={{ marginTop: "22px", textAlign: "center" }}
              >
                <p className="premium-muted">Cash Difference</p>
                <h3 className="premium-title">{formatCurrency(cashDifference)}</h3>
                <p className="premium-muted">
                  {cashDifference === 0
                    ? "Cash drawer is balanced."
                    : cashDifference > 0
                      ? "Drawer has extra cash."
                      : "Drawer is short."}
                </p>
              </div>

              <div style={{ marginTop: "22px" }}>
                <label className="premium-muted">Shift Note</label>
                <textarea
                  rows="3"
                  placeholder="Optional remarks..."
                  value={shiftNote}
                  onChange={(event) => setShiftNote(event.target.value)}
                />
              </div>

              {shiftMessage && (
                <div
                  className="premium-card"
                  style={{ marginTop: "22px", textAlign: "center" }}
                >
                  <p className="premium-muted">{shiftMessage}</p>
                </div>
              )}

              <div className="app-modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowEndShiftModal(false)}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleEndShift}
                >
                  Submit Shift Report
                </button>
              </div>
            </div>
          </div>
        )}

        {showProductSearch && (
          <div className="app-modal-overlay">
            <div className="app-modal">
              <div className="app-modal-header">
                <h2 className="premium-title">Product Lookup</h2>
                <button
                  type="button"
                  className="app-modal-close"
                  onClick={() => {
                    setShowProductSearch(false);
                    setProductSearchQuery("");
                    setProductSearchResults([]);
                  }}
                >
                  ×
                </button>
              </div>

              <div style={{ position: 'relative', marginBottom: '22px' }}>
                <FontAwesomeIcon icon={faSearch} style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: 'var(--color-muted)' }} />
                <input
                  type="text"
                  placeholder="Type to search products..."
                  value={productSearchQuery}
                  onChange={(event) => setProductSearchQuery(event.target.value)}
                  style={{ paddingLeft: '42px' }}
                  autoFocus
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {productSearchLoading ? (
                  <div style={{ textAlign: 'center', padding: '40px' }} className="premium-muted">Searching...</div>
                ) : productSearchResults.length > 0 ? (
                  productSearchResults.map((product) => (
                    <div key={product.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', background: 'var(--color-surface-solid)', borderRadius: '12px' }}>
                      <div>
                        <strong>{product.name}</strong>
                        <p className="premium-muted" style={{ margin: 0 }}>SKU: {product.sku || "N/A"}</p>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <strong className="premium-title">{formatCurrency(product.price)}</strong>
                        <p className="premium-muted" style={{ margin: 0 }}>Stock: {product.stock || 0}</p>
                      </div>
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() => handleAddToCart(product)}
                      >
                        <FontAwesomeIcon icon={faPlus} />
                      </button>
                    </div>
                  ))
                ) : productSearchQuery ? (
                  <div style={{ textAlign: 'center', padding: '40px' }} className="premium-muted">
                    <FontAwesomeIcon icon={faBoxOpen} style={{ fontSize: '2rem', marginBottom: '12px' }} />
                    <p>No products found</p>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px' }} className="premium-muted">
                    <FontAwesomeIcon icon={faSearch} style={{ fontSize: '2rem', marginBottom: '12px' }} />
                    <p>Enter a search term to find products</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {showCustomerSearch && (
          <div className="app-modal-overlay">
            <div className="app-modal">
              <div className="app-modal-header">
                <h2 className="premium-title">Customer Lookup</h2>
                <button
                  type="button"
                  className="app-modal-close"
                  onClick={() => {
                    setShowCustomerSearch(false);
                    setCustomerSearchQuery("");
                    setCustomerSearchResults([]);
                  }}
                >
                  ×
                </button>
              </div>

              <div style={{ position: 'relative', marginBottom: '22px' }}>
                <FontAwesomeIcon icon={faSearch} style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: 'var(--color-muted)' }} />
                <input
                  type="text"
                  placeholder="Type to search customers..."
                  value={customerSearchQuery}
                  onChange={(event) => setCustomerSearchQuery(event.target.value)}
                  style={{ paddingLeft: '42px' }}
                  autoFocus
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {customerSearchLoading ? (
                  <div style={{ textAlign: 'center', padding: '40px' }} className="premium-muted">Searching...</div>
                ) : customerSearchResults.length > 0 ? (
                  customerSearchResults.map((customer) => (
                    <div key={customer.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', background: 'var(--color-surface-solid)', borderRadius: '12px' }}>
                      <div>
                        <strong>{customer.name}</strong>
                        <p className="premium-muted" style={{ margin: 0 }}>{customer.phone || "No phone"}</p>
                      </div>
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() => handleSelectCustomer(customer)}
                      >
                        Select
                      </button>
                    </div>
                  ))
                ) : customerSearchQuery ? (
                  <div style={{ textAlign: 'center', padding: '40px' }} className="premium-muted">
                    <FontAwesomeIcon icon={faUser} style={{ fontSize: '2rem', marginBottom: '12px' }} />
                    <p>No customers found</p>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px' }} className="premium-muted">
                    <FontAwesomeIcon icon={faSearch} style={{ fontSize: '2rem', marginBottom: '12px' }} />
                    <p>Enter a search term to find customers</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
    </DashboardLayout>
  );
};

export default CashierDashboard;
