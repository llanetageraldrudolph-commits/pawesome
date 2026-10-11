import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { apiRequest } from "../../api/client";
import { lookupBarcode } from "../../api/pos";
import "./CashierPOS.css";
import {
  normalizeList,
  getAvailableStock,
  normProduct,
  formatCurrency,
} from "../../utils/apiNormalize";
import { showError } from "../../utils/alert.jsx";
import { printReceipt } from "../../utils/receiptPrinter";
import { STORE_INFO } from "../../utils/storeInfo";
import PaymentApprovals from "./components/PaymentApprovals";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faPaw, faRotateRight, faTrash, faBoxOpen,
  faShoppingCart, faCreditCard, faMoneyBillWave, faMobileScreen,
  faTriangleExclamation, faPlus,
  faMinus, faXmark, faPrint, faClock, faBox, faCheckCircle,
  faBarcode, faKeyboard, faCamera,
  faBolt, faUser, faList,
  faStore, faHistory, faBan, faExpand, faCompress,
  faBars, faChartBar, faUserCircle, faClipboardList, faWallet,
  faBone, faScissors, faBasketball, faPills, faBriefcaseMedical,
  faDeleteLeft,
} from "@fortawesome/free-solid-svg-icons";
import QrScanner from "../shared/QrScanner";

/* ---------- Constants -------------------------------------------- */
const PRODUCT_ENDPOINT  = "/cashier/inventory/sellable";
const SERVICE_ENDPOINT  = "/cashier/pos/services";
const CHECKOUT_ENDPOINT = "/cashier/pos/transaction";
const TAX_RATE = 0.12;

const PAYMENT_METHODS = [
  { value: "Cash",  label: "Cash",  icon: faMoneyBillWave, color: "#10B981" },
  { value: "GCash", label: "GCash", icon: faMobileScreen,  color: "#4F46E5" },
  { value: "Maya",  label: "Maya",  icon: faWallet,        color: "#00A4E0" },
];

const CATEGORY_CONFIG = {
  all:         { label: "All Items",    icon: faStore,            color: "#ff5f93", bg: "#fff1f7" },
  food:        { label: "Pet Food",     icon: faPaw,              color: "#F97316", bg: "#FFF7ED" },
  accessories: { label: "Accessories",  icon: faBone,             color: "#8B5CF6", bg: "#F5F3FF" },
  grooming:    { label: "Grooming",     icon: faScissors,         color: "#EC4899", bg: "#FDF2F8" },
  toys:        { label: "Toys",         icon: faBasketball,       color: "#14B8A6", bg: "#ECFDF5" },
  health:      { label: "Health & Meds",icon: faPills,            color: "#EF4444", bg: "#FEF2F2" },
  services:    { label: "Services",     icon: faBriefcaseMedical, color: "#64748B", bg: "#F1F5F9" },
};

/* Numpad bill presets */
const BILL_PRESETS = [50, 100, 200, 500, 1000];

/* ---------- Helpers ---------------------------------------------- */
const fmt = (amount) => formatCurrency(amount, { minimumFractionDigits: 0 });

const discountedPrice = (p) => {
  const price = Number(p.price) || 0;
  const disc  = Number(p.discount) || 0;
  return disc > 0 ? price * (1 - disc / 100) : price;
};

const stockStatus = (stock) => {
  const q = getAvailableStock({ available_stock: stock });
  if (q <= 0) return { label: "Out of stock", type: "out" };
  if (q <= 5) return { label: `Only ${q} left`, type: "low" };
  return { label: `${q} in stock`, type: "ok" };
};

const isProductOutOfStock = (product) => getAvailableStock(product) <= 0;

/* ---------- Main Component --------------------------------------- */
const CashierPOS = ({ initialTab }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  /* ── Core state ─────────────────────────────────────── */
  const [products, setProducts]           = useState([]);
  const [services, setServices]           = useState([]);
  const [cart, setCart]                   = useState([]);
  const [activeCategory, setActiveCategory] = useState("all");
  const [activeTab, setActiveTab]         = useState(initialTab || "products");

  // Deep links (e.g. /cashier/payment-verification from notifications) re-select their tab on
  // every navigation without remounting, so an in-progress cart is preserved.
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab, location.key]);
  const [pendingCount, setPendingCount]   = useState(0);
  const [searchQuery, setSearchQuery]     = useState("");
  const orderType                          = "walk-in";
  const [customers, setCustomers]         = useState([]);
  const [customerId, setCustomerId]       = useState(null);
  const [customerName, setCustomerName]   = useState("");

  /* ── UI state ────────────────────────────────────────── */
  const [paymentMethod, setPaymentMethod] = useState("Cash");
  const [amountReceived, setAmountReceived] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [checkoutStep, setCheckoutStep] = useState("cart"); // "cart" | "payment"

  /* ── Loading / error ─────────────────────────────────── */
  const [loading, setLoading]             = useState(true);
  const [isRefreshingProducts, setIsRefreshingProducts] = useState(false);
  const [lastStockSyncAt, setLastStockSyncAt] = useState(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [error, setError]                 = useState("");

  /* ── Receipt & misc ──────────────────────────────────── */
  const [completedReceipt, setCompletedReceipt] = useState(null);
  const [toasts, setToasts]               = useState([]);
  const [isFullscreen, setIsFullscreen]   = useState(false);
  const [showNavMenu, setShowNavMenu]     = useState(false);
  const [viewPhotoUrl, setViewPhotoUrl]   = useState(null);
  const [showHelp, setShowHelp]           = useState(false);

  /* ── Webcam barcode scanner ──────────────────────────── */
  const [posWebcamOpen, setPosWebcamOpen] = useState(false);

  const searchRef                 = useRef(null);
  const navMenuRef                = useRef(null);
  const latestInventoryRequestRef = useRef(0);
  const productsRef               = useRef([]);
  const barcodeLookupInFlightRef  = useRef(false);
  const categoryTabsRef           = useRef(null);

  /* ── Toast helper ─────────────────────────────────── */
  const addToast = useCallback((message, type = "info") => {
    const id = Date.now();
    setToasts(prev => {
      const next = [...prev, { id, message, type, createdAt: Date.now() }];
      return next.slice(-3);
    });
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3200);
  }, []);

  useEffect(() => { productsRef.current = products; }, [products]);

  /* ── Fullscreen ─────────────────────────────────────── */
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen()
        .then(() => { setIsFullscreen(true); addToast("Entered fullscreen", "success"); })
        .catch(() => addToast("Could not enter fullscreen", "error"));
    } else {
      document.exitFullscreen()
        .then(() => { setIsFullscreen(false); addToast("Exited fullscreen", "info"); })
        .catch(() => addToast("Could not exit fullscreen", "error"));
    }
  }, [addToast]);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  /* ── Click-outside nav menu ─────────────────────────── */
  useEffect(() => {
    const handler = (e) => {
      if (navMenuRef.current && !navMenuRef.current.contains(e.target)) setShowNavMenu(false);
    };
    if (showNavMenu) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showNavMenu]);

  /* ── Reconcile cart with fresh stock ─────────────────── */
  const reconcileCartWithProducts = useCallback((freshProducts) => {
    const stockById = new Map(freshProducts.map((p) => [p.id, getAvailableStock(p)]));
    setCart((prevCart) => prevCart
      .map((item) => {
        const latestStock = stockById.get(item.id);
        if (latestStock === undefined) return item;
        if (latestStock <= 0) {
          addToast(`${item.name} removed — out of stock`, "warn");
          return null;
        }
        if (item.quantity > latestStock) {
          addToast(`${item.name} quantity adjusted to ${latestStock}`, "warn");
          return { ...item, stock: latestStock, available_stock: latestStock, quantity: latestStock };
        }
        return { ...item, stock: latestStock, available_stock: latestStock };
      })
      .filter(Boolean));
  }, [addToast]);

  /* ── Data fetch ─────────────────────────────────────── */
  const fetchProducts = useCallback(async ({ silent = false } = {}) => {
    const requestId = latestInventoryRequestRef.current + 1;
    latestInventoryRequestRef.current = requestId;
    try {
      if (productsRef.current.length === 0 && !silent) setLoading(true);
      else setIsRefreshingProducts(true);
      const response = await apiRequest(PRODUCT_ENDPOINT);
      if (latestInventoryRequestRef.current !== requestId) return;
      const raw        = normalizeList(response, ["products", "items", "data", "inventory", "sellable_items"]);
      const normalized = raw.map((p, i) => normProduct(p, i));
      setProducts(normalized);
      reconcileCartWithProducts(normalized);
      setLastStockSyncAt(new Date());
      setError("");
    } catch (err) {
      if (latestInventoryRequestRef.current === requestId) {
        const message = err.message || "Unable to refresh stock";
        if (productsRef.current.length === 0) { setError(message); showError(message); }
        else addToast("Unable to refresh stock. Keeping previous list.", "warn");
      }
    } finally {
      if (latestInventoryRequestRef.current === requestId) {
        setLoading(false);
        setIsRefreshingProducts(false);
      }
    }
  }, [addToast, reconcileCartWithProducts]);

  const fetchServices = useCallback(async () => {
    try {
      const res = await apiRequest(SERVICE_ENDPOINT);
      const raw = normalizeList(res, ["services", "data"]);
      setServices(raw);
    } catch { setServices([]); }
  }, []);

  const fetchCustomers = useCallback(async () => {
    // Try the cashier-prefixed endpoint first, fall back to the shared /customers route
    const endpoints = ["/cashier/customers", "/customers"];
    for (const endpoint of endpoints) {
      try {
        const res = await apiRequest(endpoint);
        const raw = normalizeList(res, ["customers", "data", "items"]);
        if (Array.isArray(raw) && raw.length > 0) {
          setCustomers(raw);
          return;
        }
        // Got an empty array — still valid, stop trying other endpoints
        if (Array.isArray(raw)) { setCustomers(raw); return; }
      } catch { /* try next endpoint */ }
    }
    setCustomers([]);
  }, []);

  const fetchPendingCount = useCallback(async () => {
    try {
      const data = await apiRequest("/cashier/payment-requests");
      const list = data?.data || data?.requests || data?.payments || data || [];
      const pending = list.filter(r => {
        const ps = (r.payment_status || "pending").toLowerCase();
        return ps === "pending" || ps === "unpaid";
      });
      setPendingCount(pending.length);
    } catch { setPendingCount(0); }
  }, []);

  useEffect(() => { fetchProducts(); fetchServices(); fetchCustomers(); fetchPendingCount(); }, [fetchProducts, fetchServices, fetchCustomers, fetchPendingCount]);

  useEffect(() => {
    const si = setInterval(() => fetchPendingCount(), 30000);
    return () => clearInterval(si);
  }, [fetchPendingCount]);

  useEffect(() => {
    const si = setInterval(() => fetchServices(), 30000);
    return () => clearInterval(si);
  }, [fetchServices]);

  /* ── Derived data ───────────────────────────────────── */
  const allItems = useMemo(() => [
    ...products,
    ...services.map(s => ({ ...s, id: `svc-${s.id}`, _serviceId: s.id })),
  ], [products, services]);

  const categories = useMemo(() => {
    const grouped = allItems.reduce((acc, p) => {
      acc[p.category] = (acc[p.category] || 0) + 1;
      return acc;
    }, {});
    const catList = [
      { id: "all", label: CATEGORY_CONFIG.all.label, count: allItems.length, config: CATEGORY_CONFIG.all },
      ...Object.entries(grouped).map(([id, count]) => ({
        id,
        label: CATEGORY_CONFIG[id]?.label || id.replace(/\b\w/g, c => c.toUpperCase()),
        count,
        config: CATEGORY_CONFIG[id] || { icon: faBox, color: "#64748B", bg: "#F1F5F9" },
      })),
    ];
    return catList.sort((a, b) => {
      if (a.id === "all") return -1;
      if (b.id === "all") return 1;
      return b.count - a.count;
    });
  }, [allItems]);

  const filteredProducts = useMemo(() => {
    const kw = searchQuery.trim().toLowerCase();
    return allItems.filter(p => {
      const matchCat    = activeCategory === "all" || p.category === activeCategory;
      const matchSearch = !kw
        || p.name.toLowerCase().includes(kw)
        || (p.service_category || p.category || "").toLowerCase().includes(kw)
        || String(p.barcode || "").toLowerCase().includes(kw);
      return matchCat && matchSearch;
    });
  }, [allItems, activeCategory, searchQuery]);

  const lowStockCount  = useMemo(() => products.filter(p => getAvailableStock(p) > 0 && getAvailableStock(p) <= 5).length, [products]);
  const outOfStockCount = useMemo(() => products.filter(p => isProductOutOfStock(p)).length, [products]);

  /* ── Cart operations ────────────────────────────────── */
  const addToCart = useCallback((product) => {
    const isService      = product.item_type === "service";
    const availableStock = isService ? 9999 : getAvailableStock(product);
    if (!isService && availableStock <= 0) { addToast(`${product.name} is out of stock`, "warn"); return; }
    setCart(prev => {
      const existing = prev.find(i => i.id === product.id);
      if (existing) {
        if (existing.quantity >= availableStock) { addToast("Maximum stock reached", "warn"); return prev; }
        return prev.map(i => i.id === product.id ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, { ...product, quantity: 1 }];
    });
  }, [addToast]);

  const updateQty = useCallback((id, qty) => {
    const n = Number(qty) || 0;
    if (n <= 0) { setCart(prev => prev.filter(i => i.id !== id)); return; }
    setCart(prev => prev.map(i => {
      if (i.id !== id) return i;
      const availableStock = getAvailableStock(i);
      return { ...i, quantity: Math.min(n, availableStock || n) };
    }));
  }, []);

  const removeFromCart = useCallback((id) => setCart(prev => prev.filter(i => i.id !== id)), []);

  const clearOrder = useCallback(() => {
    setCart([]);
    setCustomerId(null);
    setCustomerName("");
    setPaymentMethod("Cash");
    setAmountReceived("");
    setReferenceNumber("");
    setCheckoutStep("cart");
  }, []);

  /* ── Totals ─────────────────────────────────────────── */
  const subtotal    = useMemo(() => cart.reduce((sum, i) => sum + discountedPrice(i) * i.quantity, 0), [cart]);
  const vatAmount   = useMemo(() => subtotal * TAX_RATE / (1 + TAX_RATE), [subtotal]);  // VAT portion extracted from VAT-inclusive price
  const netAmount   = useMemo(() => subtotal - vatAmount, [subtotal, vatAmount]);        // Net amount (ex-VAT)
  const total       = useMemo(() => subtotal, [subtotal]);                               // Total = subtotal (VAT-inclusive)
  const change      = useMemo(() => Math.max((Number(amountReceived) || 0) - total, 0), [amountReceived, total]);

  const cartCount   = useMemo(() => cart.reduce((sum, i) => sum + i.quantity, 0), [cart]);

  const canCheckout = cart.length > 0
    && cart.every((item) => item.item_type === "service" || item.quantity <= getAvailableStock(item))
    && !checkoutLoading
    && (paymentMethod !== "Cash" || (Number(amountReceived) || 0) >= total)
    && (paymentMethod === "Cash" || referenceNumber.trim() !== "");

  /* ── Barcode / search enter ─────────────────────────── */
  const handleSearchEnter = useCallback(async () => {
    const kw = searchQuery.trim();
    if (!kw) return;
    if (barcodeLookupInFlightRef.current) return;
    barcodeLookupInFlightRef.current = true;
    try {
      const looksLikeBarcode = !/\s/.test(kw) && kw.length >= 4 && /^[A-Za-z0-9\-]+$/.test(kw);
      if (looksLikeBarcode) {
        try {
          const item = await lookupBarcode(kw);
          if (item) {
            const sellable = item.is_sellable ?? item.sellable ?? true;
            const stock    = getAvailableStock(item);
            if (!sellable) addToast("Item is not available for POS sale.", "warn");
            else if (stock <= 0) addToast(`${item.name} is out of stock.`, "warn");
            else { addToCart(normProduct(item)); addToast(`${item.name} added`, "success"); }
            setSearchQuery("");
            searchRef.current?.focus();
            return;
          }
        } catch (err) {
          const status = err?.status;
          if (status !== 404) {
            addToast(err?.message || "Barcode lookup failed.", "error");
            setSearchQuery("");
            searchRef.current?.focus();
            return;
          }
        }
      }
      if (filteredProducts.length === 1) {
        addToCart(filteredProducts[0]);
        setSearchQuery("");
        addToast(`${filteredProducts[0].name} added`, "success");
      } else if (looksLikeBarcode) {
        addToast("Barcode not found.", "error");
        setSearchQuery("");
      }
    } finally {
      barcodeLookupInFlightRef.current = false;
    }
  }, [searchQuery, filteredProducts, addToCart, addToast]);

  /* ── Webcam barcode scan handler ─────────────────────── */
  const handleWebcamScan = useCallback(async (code) => {
    setPosWebcamOpen(false);
    const trimmed = code.trim();
    if (!trimmed) return;
    if (barcodeLookupInFlightRef.current) return;
    barcodeLookupInFlightRef.current = true;
    try {
      const item = await lookupBarcode(trimmed);
      if (item) {
        const sellable = item.is_sellable ?? item.sellable ?? true;
        const stock    = getAvailableStock(item);
        if (!sellable) addToast("Item is not available for POS sale.", "warn");
        else if (stock <= 0) addToast(`${item.name} is out of stock.`, "warn");
        else { addToCart(normProduct(item)); addToast(`${item.name} added`, "success"); }
      } else {
        addToast("Barcode not found.", "error");
      }
    } catch (err) {
      addToast(err?.message || "Barcode not found or lookup failed.", "error");
    } finally {
      barcodeLookupInFlightRef.current = false;
    }
  }, [addToCart, addToast]);

  /* ── Keyboard shortcuts ──────────────────────────────── */
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "F1") { e.preventDefault(); setShowHelp(true); }
      if (e.key === "F2") { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === "F3") { e.preventDefault(); if (cart.length > 0) clearOrder(); }
      if (e.key === "F4") { e.preventDefault(); if (cart.length > 0) setCheckoutStep("payment"); }
      if (e.key === "Escape") {
        if (completedReceipt) { setCompletedReceipt(null); return; }
        if (searchQuery) { setSearchQuery("");    return; }
      }
      if (e.key === "Enter" && e.target === searchRef.current) {
        e.preventDefault();
        handleSearchEnter();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cart.length, searchQuery, completedReceipt, handleSearchEnter, clearOrder]);

  /* ── Numpad input ────────────────────────────────────── */
  const handleNumpad = useCallback((key) => {
    setAmountReceived(prev => {
      if (key === "C") return "";
      if (key === "⌫") return prev.slice(0, -1);
      if (key === "00") return (prev === "" || prev === "0") ? "" : prev + "00";
      return prev + key;
    });
  }, []);

  const handleBillPreset = useCallback((amount) => {
    setAmountReceived(String(amount));
  }, []);

  /* ── Checkout ────────────────────────────────────────── */
  const handleCheckout = useCallback(async () => {
    if (!canCheckout) return;
    try {
      setCheckoutLoading(true);
      const payload = {
        order_type: orderType,
        customer_id: customerId || null,
        customer_name: customerName || "Walk-in Customer",
        payment_method: paymentMethod.toLowerCase(),
        cash_received: Number(amountReceived) || total,
        subtotal, tax: vatAmount, discount: 0, total,
        reference_number: (paymentMethod === "GCash" || paymentMethod === "Maya") ? referenceNumber : null,
        items: cart.map(i => {
          const isService = i.item_type === "service";
          return {
            item_type:     isService ? "service" : "product",
            item_id:       isService ? undefined : i.id,
            service_id:    isService ? i._serviceId : undefined,
            item_name:     i.name,
            quantity:      i.quantity,
            unit_price:    Number(i.price) || 0,
            discount_amount: Number(i.discount) || 0,
          };
        }),
      };
      const res = await apiRequest(CHECKOUT_ENDPOINT, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const txId = res?.transaction?.transaction_number
        || res?.transaction?.id
        || res?.transaction_id
        || res?.id
        || `TRX-${Date.now()}`;
      const receipt = {
        transaction_id:  String(txId).startsWith("TRX-") ? String(txId) : `TRX-${String(txId).padStart(4, "0")}`,
        customer_name:   payload.customer_name,
        payment_method:  paymentMethod,
        amount_received: Number(amountReceived) || total,
        subtotal, net_amount: netAmount, vat_amount: vatAmount, total,
        change: Math.max((Number(amountReceived) || total) - total, 0),
        items: payload.items,
        reference_number: (paymentMethod === "GCash" || paymentMethod === "Maya") ? referenceNumber : null,
        date: new Date().toLocaleString("en-PH", { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }),
      };
      addToast("Payment successful!", "success");
      clearOrder();
      // Auto-show receipt immediately after checkout
      setCompletedReceipt(receipt);
      fetchProducts({ silent: true });
      fetchServices();
    } catch (err) {
      addToast(err.message || "Checkout failed. Please try again.", "error");
    } finally {
      setCheckoutLoading(false);
    }
  }, [canCheckout, orderType, customerId, customerName, paymentMethod, amountReceived, total, subtotal, vatAmount, netAmount, referenceNumber, cart, addToast, clearOrder, fetchProducts, fetchServices]);

  /* ── Print ──────────────────────────────────────────── */
  const handlePrint = useCallback(() => {
    const r = completedReceipt;
    if (!r || !Array.isArray(r.items)) return;
    printReceipt({
      title: "Sales Invoice",
      receiptNumber: r.receipt_number || r.transaction_id,
      date: r.date,
      cashier: r.cashier_name || user?.name || "Cashier",
      customer: r.customer_name || "Walk-in",
      paymentMethod: r.payment_method,
      paymentStatus: r.payment_status || "paid",
      referenceNumber: r.reference_number,
      items: r.items.map(i => ({
        name:      i.item_name,
        quantity:  i.quantity,
        unitPrice: i.unit_price,
        total:     (i.unit_price || 0) * i.quantity,
      })),
      subtotal: r.subtotal,
      vat: r.vat_amount,
      discount: 0,
      total: r.total,
      amountReceived: r.amount_received,
      change: r.change,
    });
  }, [completedReceipt, user]);

  /* ─────────────────────── RENDER ─────────────────────── */
  return (
    <>
      <div className="pos-kiosk">
      <div className="pos-main">

        {/* ── TopBar ──────────────────────────────────── */}
        <header className="pos-topbar">
          <div className="pos-topbar-brand">
            <div className="pos-brand-mark"><FontAwesomeIcon icon={faPaw} /></div>
            <span className="pos-brand-name">Pawesome POS</span>
          </div>

          <div className="pos-search-area">
            <div className="pos-search-wrap">
              <FontAwesomeIcon icon={faBarcode} className="pos-search-icon" />
              <input
                ref={searchRef}
                className="pos-search-input"
                type="text"
                placeholder="Search products or scan barcode…  (Enter to add)"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleSearchEnter(); } }}
              />
              {searchQuery && (
                <button className="pos-search-clear" onClick={() => setSearchQuery("")}>
                  <FontAwesomeIcon icon={faXmark} />
                </button>
              )}
            </div>
            <button
              type="button"
              className={`pos-cam-btn ${posWebcamOpen ? "active" : ""}`}
              onClick={() => setPosWebcamOpen((v) => !v)}
              title={posWebcamOpen ? "Close webcam scanner" : "Scan barcode with webcam"}
              aria-label="Toggle webcam scanner"
            >
              <FontAwesomeIcon icon={faCamera} />
            </button>

            {/* Floating webcam scanner panel */}
            {posWebcamOpen && (
              <div className="pos-webcam-panel" onClick={(e) => e.stopPropagation()}>
                <div className="pos-webcam-header">
                  <span>Scan Product Barcode</span>
                  <button
                    type="button"
                    className="pos-webcam-close"
                    onClick={() => setPosWebcamOpen(false)}
                    aria-label="Close scanner"
                  >
                    <FontAwesomeIcon icon={faXmark} />
                  </button>
                </div>
                <QrScanner
                  onScan={handleWebcamScan}
                  stopOnScan={true}
                />
              </div>
            )}
          </div>

          <div className="pos-topbar-right">
            {lowStockCount > 0 && (
              <span className="pos-alert-badge pos-alert-badge--warn">
                <FontAwesomeIcon icon={faTriangleExclamation} /> {lowStockCount} Low
              </span>
            )}
            {outOfStockCount > 0 && (
              <span className="pos-alert-badge pos-alert-badge--danger">
                <FontAwesomeIcon icon={faBan} /> {outOfStockCount} Out
              </span>
            )}

            <button className="pos-topbar-btn" onClick={() => { fetchProducts(); fetchServices(); }} title="Refresh products">
              <FontAwesomeIcon icon={faRotateRight} spin={isRefreshingProducts} />
            </button>

            <button className="pos-topbar-btn" onClick={toggleFullscreen} title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}>
              <FontAwesomeIcon icon={isFullscreen ? faCompress : faExpand} />
            </button>

            <button className="pos-topbar-btn pos-topbar-btn--optional" onClick={() => setShowHelp(true)} title="Keyboard shortcuts">
              <FontAwesomeIcon icon={faKeyboard} />
            </button>

            <div className="pos-nav-wrap" ref={navMenuRef}>
              <button className="pos-topbar-btn" onClick={() => setShowNavMenu(!showNavMenu)}>
                <FontAwesomeIcon icon={faBars} />
              </button>
              {showNavMenu && (
                <div className="pos-nav-dropdown">
                  <div className="pos-nav-header">Navigate</div>
                  <button className="pos-nav-item" onClick={() => { navigate('/cashier/dashboard'); setShowNavMenu(false); }}>
                    <FontAwesomeIcon icon={faChartBar} /> Dashboard
                  </button>
                  <button className="pos-nav-item" onClick={() => { navigate('/cashier/transactions'); setShowNavMenu(false); }}>
                    <FontAwesomeIcon icon={faClipboardList} /> Transactions
                  </button>
                  <button className="pos-nav-item" onClick={() => { navigate('/cashier/reports'); setShowNavMenu(false); }}>
                    <FontAwesomeIcon icon={faChartBar} /> Reports
                  </button>
                  <button className="pos-nav-item" onClick={() => { navigate('/cashier/history'); setShowNavMenu(false); }}>
                    <FontAwesomeIcon icon={faHistory} /> History
                  </button>
                  <button className="pos-nav-item" onClick={() => { navigate('/cashier/profile'); setShowNavMenu(false); }}>
                    <FontAwesomeIcon icon={faUserCircle} /> Profile
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* ── Category Tabs ────────────────────────────── */}
        <nav className="pos-category-tabs" ref={categoryTabsRef}>
          {categories.map(cat => (
            <button
              key={cat.id}
              className={`pos-cat-tab${activeTab === "products" && activeCategory === cat.id ? " active" : ""}`}
              style={{ "--cat-color": cat.config?.color, "--cat-bg": cat.config?.bg }}
              onClick={() => { setActiveTab("products"); setActiveCategory(cat.id); }}
            >
              <FontAwesomeIcon icon={cat.config?.icon || faBox} className="pos-cat-tab-icon" />
              <span className="pos-cat-tab-label">{cat.label}</span>
              <span className="pos-cat-tab-count">{cat.count}</span>
            </button>
          ))}

          <div className="pos-cat-tab-divider" />

          <button
            className={`pos-cat-tab pos-cat-tab--approvals${activeTab === "payment-approvals" ? " active" : ""}`}
            style={{ "--cat-color": "#10b981", "--cat-bg": "#ecfdf5" }}
            onClick={() => setActiveTab("payment-approvals")}
          >
            <FontAwesomeIcon icon={faCheckCircle} className="pos-cat-tab-icon" />
            <span className="pos-cat-tab-label">Payment Approvals</span>
            {pendingCount > 0 && <span className="pos-cat-tab-count pos-cat-tab-count--highlight">{pendingCount}</span>}
          </button>
        </nav>

        {/* ── Product Area ──────────────────────────────── */}
        <main className="pos-product-area">
          {activeTab === "payment-approvals" ? (
            <div className="pos-approvals-wrap">
              <PaymentApprovals />
            </div>
          ) : (
            <>
              {/* Stock sync info bar */}
              <div className="pos-info-bar">
                <span className="pos-info-count">
                  <FontAwesomeIcon icon={faList} />
                  {isRefreshingProducts
                    ? " Refreshing…"
                    : ` ${filteredProducts.length} item${filteredProducts.length !== 1 ? "s" : ""}`}
                </span>
                {lastStockSyncAt && (
                  <span className="pos-info-sync">
                    Synced {lastStockSyncAt.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </div>

              {/* Product Grid */}
              {loading ? (
                <div className="pos-state-card">
                  <div className="pos-spinner" />
                  <div className="pos-state-title">Loading products…</div>
                  <div className="pos-state-sub">Fetching inventory from the server.</div>
                </div>
              ) : error ? (
                <div className="pos-state-card">
                  <div className="pos-state-icon"><FontAwesomeIcon icon={faTriangleExclamation} /></div>
                  <div className="pos-state-title">Could not load products</div>
                  <div className="pos-state-sub">{error}</div>
                  <button className="pos-btn-retry" onClick={fetchProducts}><FontAwesomeIcon icon={faRotateRight} /> Retry</button>
                </div>
              ) : filteredProducts.length === 0 ? (
                <div className="pos-state-card">
                  <div className="pos-state-icon"><FontAwesomeIcon icon={faBoxOpen} /></div>
                  <div className="pos-state-title">No products found</div>
                  <div className="pos-state-sub">Try another category or clear the search.</div>
                  {searchQuery && (
                    <button className="pos-btn-retry" onClick={() => setSearchQuery("")}><FontAwesomeIcon icon={faXmark} /> Clear Search</button>
                  )}
                </div>
              ) : (
                <div className="pos-product-grid">
                  {filteredProducts.map(product => {
                    const cartItem   = cart.find(i => i.id === product.id);
                    const dPrice     = discountedPrice(product);
                    const hasDisc    = Number(product.discount) > 0;
                    const availStock = getAvailableStock(product);
                    const outOfStock = availStock <= 0;
                    const ss         = stockStatus(availStock);
                    const isService  = product.item_type === "service";
                    return (
                      <article
                        key={product.id}
                        className={`pos-tile${cartItem ? " pos-tile--in-cart" : ""}${outOfStock ? " pos-tile--oos" : ""}${isService ? " pos-tile--service" : ""}`}
                        onClick={() => !outOfStock && addToCart(product)}
                      >
                        {/* Image area */}
                        <div className="pos-tile-img">
                          {product.image
                            ? <img src={product.image} alt={product.name} onClick={(e) => { e.stopPropagation(); setViewPhotoUrl(product.image); }} />
                            : <FontAwesomeIcon icon={isService ? faBriefcaseMedical : faBoxOpen} className="pos-tile-placeholder" />
                          }
                          {hasDisc && <span className="pos-tile-disc-badge">-{product.discount}%</span>}
                          {isService && <span className="pos-tile-service-badge">SERVICE</span>}
                          {cartItem && <span className="pos-tile-cart-badge">{cartItem.quantity}</span>}
                        </div>

                        {/* Info */}
                        <div className="pos-tile-body">
                          <div className="pos-tile-name" title={product.name}>{product.name}</div>
                          <div className="pos-tile-price-row">
                            <span className="pos-tile-price">{fmt(dPrice)}</span>
                            {hasDisc && <span className="pos-tile-price-old">{fmt(product.price)}</span>}
                          </div>
                          <span className={`pos-tile-stock pos-tile-stock--${ss.type}`}>{isService ? "Unlimited" : ss.label}</span>
                        </div>

                        {/* Add / stepper */}
                        <div className="pos-tile-action">
                          {outOfStock ? (
                            <span className="pos-tile-oos-label">Out of Stock</span>
                          ) : cartItem ? (
                            <div className="pos-tile-stepper" onClick={e => e.stopPropagation()}>
                              <button className="pos-stepper-btn" onClick={() => updateQty(product.id, cartItem.quantity - 1)}>
                                <FontAwesomeIcon icon={faMinus} />
                              </button>
                              <span className="pos-stepper-qty">{cartItem.quantity}</span>
                              <button
                                className="pos-stepper-btn"
                                onClick={() => updateQty(product.id, cartItem.quantity + 1)}
                                disabled={!isService && cartItem.quantity >= availStock}
                              >
                                <FontAwesomeIcon icon={faPlus} />
                              </button>
                            </div>
                          ) : (
                            <button className="pos-tile-add-btn">
                              <FontAwesomeIcon icon={faPlus} /> Add
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* ── Two-step Order Panel ── hidden on the approvals tab so the
          payment queue gets the full width (cart state lives here, so it
          survives the unmount). */}
      {activeTab !== "payment-approvals" && (
      <aside className="pos-order-panel">

        {/* Step indicator */}
        <div className="pos-step-indicator">
          <div className={`pos-step-chip${checkoutStep === "cart" ? " pos-step-chip--active" : " pos-step-chip--done"}`}>
            {checkoutStep === "payment" ? <FontAwesomeIcon icon={faCheckCircle} /> : "1"} Cart
          </div>
          <div className={`pos-step-connector${checkoutStep === "payment" ? " pos-step-connector--active" : ""}`} />
          <div className={`pos-step-chip${checkoutStep === "payment" ? " pos-step-chip--active" : " pos-step-chip--pending"}`}>
            2 Payment
          </div>
        </div>

        {checkoutStep === "cart" ? (
          <div key="cart" className="pos-step-body">
            {/* Panel Header */}
            <div className="pos-drawer-header">
              <div className="pos-drawer-title">
                <FontAwesomeIcon icon={faShoppingCart} />
                Current Order
                {cartCount > 0 && <span className="pos-order-count">{cartCount}</span>}
              </div>
              <button
                className="pos-drawer-clear"
                onClick={clearOrder}
                disabled={cart.length === 0}
                title="Clear cart (F3)"
              >
                <FontAwesomeIcon icon={faTrash} />
              </button>
            </div>

            {/* Customer */}
            <div className="pos-drawer-section">
              <div className="pos-drawer-label"><FontAwesomeIcon icon={faUser} /> Customer</div>
              <div className="pos-drawer-select-wrap">
                <select
                  className="pos-drawer-select"
                  value={customerId || ""}
                  onChange={(e) => {
                    const id = e.target.value ? Number(e.target.value) : null;
                    setCustomerId(id);
                    const c = customers.find((x) => x.id === id);
                    setCustomerName(c ? c.name : "");
                  }}
                >
                  <option value="">Walk-in Customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.phone ? ` (${c.phone})` : ""}</option>
                  ))}
                </select>
              </div>
              {!customerId && (
                <input
                  className="pos-drawer-input"
                  type="text"
                  placeholder="Enter walk-in customer name…"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
              )}
            </div>

            {/* Cart Items */}
            <div className="pos-cart-items">
              {cart.length === 0 ? (
                <div className="pos-cart-empty">
                  <FontAwesomeIcon icon={faShoppingCart} className="pos-cart-empty-icon" />
                  <span>Cart is empty</span>
                </div>
              ) : (
                cart.map(item => {
                  const isService = item.item_type === "service";
                  return (
                    <div className="pos-cart-row" key={item.id}>
                      <div className="pos-cart-row-info">
                        <div className="pos-cart-row-name">
                          {item.name}
                          {isService && <span className="pos-cart-service-chip">SVC</span>}
                        </div>
                        <div className="pos-cart-row-price">{fmt(discountedPrice(item))} each</div>
                      </div>
                      <div className="pos-cart-row-stepper">
                        <button className="pos-stepper-btn pos-stepper-btn--sm" onClick={() => updateQty(item.id, item.quantity - 1)}>
                          <FontAwesomeIcon icon={faMinus} />
                        </button>
                        <input
                          className="pos-stepper-input"
                          type="number"
                          min="1"
                          max={isService ? 999 : getAvailableStock(item)}
                          value={item.quantity}
                          onChange={e => updateQty(item.id, e.target.value)}
                        />
                        <button
                          className="pos-stepper-btn pos-stepper-btn--sm"
                          onClick={() => updateQty(item.id, item.quantity + 1)}
                          disabled={!isService && item.quantity >= getAvailableStock(item)}
                        >
                          <FontAwesomeIcon icon={faPlus} />
                        </button>
                      </div>
                      <div className="pos-cart-row-total">{fmt(discountedPrice(item) * item.quantity)}</div>
                      <button className="pos-cart-row-remove" onClick={() => removeFromCart(item.id)}>
                        <FontAwesomeIcon icon={faXmark} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            {/* Totals */}
            <div className="pos-drawer-totals">
              <div className="pos-totals-row">
                <span>Net Amount (ex-VAT)</span>
                <span>{fmt(netAmount)}</span>
              </div>
              <div className="pos-totals-row">
                <span>VAT 12%</span>
                <span>{fmt(vatAmount)}</span>
              </div>
              <div className="pos-totals-grand">
                <span>Total</span>
                <span>{fmt(total)}</span>
              </div>
            </div>

            {/* Proceed CTA */}
            <div className="pos-drawer-foot">
              <button
                className="pos-proceed-btn"
                onClick={() => setCheckoutStep("payment")}
                disabled={cart.length === 0}
              >
                <FontAwesomeIcon icon={faCreditCard} />
                {cart.length === 0 ? "Add items to proceed" : `Proceed to Payment — ${fmt(total)}`}
              </button>
            </div>
          </div>
        ) : (
          <div key="payment" className="pos-step-body">
            {/* Payment header with back */}
            <div className="pos-drawer-header">
              <button className="pos-back-btn" onClick={() => setCheckoutStep("cart")} title="Back to cart">
                <FontAwesomeIcon icon={faXmark} style={{ fontSize: "0.9rem" }} /> Back
              </button>
              <div className="pos-pay-summary-compact">
                <span className="pos-pay-item-count">{cartCount} item{cartCount !== 1 ? "s" : ""}</span>
                <span className="pos-pay-total-label">{fmt(total)}</span>
              </div>
            </div>

            {/* Payment Method tabs */}
            <div className="pos-payment-methods">
              {PAYMENT_METHODS.map(pm => (
                <button
                  key={pm.value}
                  className={`pos-pm-btn${paymentMethod === pm.value ? " active" : ""}`}
                  style={{ "--pm-color": pm.color }}
                  onClick={() => { setPaymentMethod(pm.value); setAmountReceived(""); setReferenceNumber(""); }}
                >
                  <FontAwesomeIcon icon={pm.icon} className="pos-pm-icon" />
                  <span>{pm.label}</span>
                </button>
              ))}
            </div>

            {/* Cash Numpad */}
            {paymentMethod === "Cash" && (
              <div className="pos-numpad-section">
                <div className="pos-numpad-display">
                  <div className="pos-numpad-received-label">Cash Received</div>
                  <div className="pos-numpad-received-value">
                    {amountReceived ? `₱${Number(amountReceived).toLocaleString("en-PH")}` : <span className="pos-numpad-placeholder">₱0</span>}
                  </div>
                  {amountReceived && Number(amountReceived) >= total ? (
                    <div className="pos-numpad-change">Change: <strong>{fmt(change)}</strong></div>
                  ) : amountReceived ? (
                    <div className="pos-numpad-change pos-numpad-change--short">Short: <strong>{fmt(total - Number(amountReceived))}</strong></div>
                  ) : null}
                </div>

                <div className="pos-bill-presets">
                  {BILL_PRESETS.map(a => (
                    <button key={a} className="pos-bill-btn" onClick={() => handleBillPreset(a)}>₱{a.toLocaleString()}</button>
                  ))}
                  <button className="pos-bill-btn pos-bill-btn--exact" onClick={() => handleBillPreset(Math.ceil(total))}>Exact</button>
                </div>

                <div className="pos-numpad">
                  {["1","2","3","4","5","6","7","8","9","00","0","⌫"].map(k => (
                    <button
                      key={k}
                      className={`pos-numpad-key${k === "⌫" ? " pos-numpad-key--delete" : ""}`}
                      onClick={() => handleNumpad(k)}
                    >
                      {k === "⌫" ? <FontAwesomeIcon icon={faDeleteLeft} /> : k}
                    </button>
                  ))}
                </div>

                <button className="pos-numpad-clear" onClick={() => handleNumpad("C")}>Clear Amount</button>
              </div>
            )}

            {/* GCash / Maya Reference */}
            {(paymentMethod === "GCash" || paymentMethod === "Maya") && (
              <div className="pos-digital-section">
                <div className="pos-digital-instruction">
                  Ask customer to show their {paymentMethod} payment screenshot, then enter the reference number below.
                </div>
                <input
                  className="pos-digital-ref-input"
                  type="text"
                  placeholder={`Enter ${paymentMethod} reference number`}
                  value={referenceNumber}
                  onChange={e => setReferenceNumber(e.target.value)}
                />
                <div className="pos-digital-amount">
                  <span>Amount to collect:</span>
                  <strong>{fmt(total)}</strong>
                </div>
              </div>
            )}

            {/* Confirm — pinned to bottom */}
            <div className="pos-order-foot">
              <button
                className="pos-confirm-btn"
                onClick={handleCheckout}
                disabled={!canCheckout || checkoutLoading}
              >
                <FontAwesomeIcon icon={checkoutLoading ? faClock : faCheckCircle} />
                {checkoutLoading ? "Processing…" : `Complete Payment — ${fmt(total)}`}
              </button>
            </div>
          </div>
        )}
      </aside>
      )}
      </div>


      {/* ── Receipt Modal ─────────────────────────────────── */}
      {completedReceipt && (
        <div className="pos-overlay" onClick={() => setCompletedReceipt(null)}>
          <div className="pos-modal" onClick={e => e.stopPropagation()}>
            <div className="pos-modal-header">
              <div>
                <div className="pos-modal-title">Payment Successful!</div>
                <div className="pos-modal-sub">{completedReceipt.transaction_id} · {completedReceipt.date}</div>
              </div>
              <button className="pos-modal-close" onClick={() => setCompletedReceipt(null)}>
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </div>
            <div className="pos-modal-body">
              <div className="pos-receipt-paper">

                {/* ── Store header ── */}
                <div className="pos-receipt-hd">
                  <div className="pos-receipt-name">PAWESOME RETREAT INC.</div>
                  {STORE_INFO.address.split("\n").map((line) => (
                    <div className="pos-receipt-addr" key={line}>{line}</div>
                  ))}
                  <div className="pos-receipt-sub">SALES INVOICE</div>
                </div>

                {/* ── Transaction info ── */}
                <div className="pos-receipt-row"><span>Receipt #</span><span>{completedReceipt.transaction_id}</span></div>
                <div className="pos-receipt-row"><span>Date</span><span>{completedReceipt.date}</span></div>
                <div className="pos-receipt-row"><span>Customer</span><span>{completedReceipt.customer_name}</span></div>
                <div className="pos-receipt-row"><span>Payment</span><span>{completedReceipt.payment_method.toUpperCase()}</span></div>
                {completedReceipt.reference_number && (
                  <div className="pos-receipt-row"><span>Reference #</span><span>{completedReceipt.reference_number}</span></div>
                )}


                {/* ── Items ── */}
                {completedReceipt.items.map((item, idx) => {
                  const unitPrice = item.unit_price || 0;
                  const lineTotal = unitPrice * item.quantity;
                  return (
                    <div className="pos-receipt-item" key={idx}>
                      <div className="pos-receipt-item-name">{item.item_name}</div>
                      <div className="pos-receipt-item-qty">{item.quantity} x {fmt(unitPrice)}</div>
                      <div className="pos-receipt-item-price">{fmt(lineTotal)}</div>
                    </div>
                  );
                })}


                {/* ── Subtotal / VAT ── */}
                <div className="pos-receipt-row"><span>Subtotal (incl. VAT)</span><span>{fmt(completedReceipt.total)}</span></div>
                <div className="pos-receipt-row"><span>VAT 12%</span><span>-{fmt(Math.abs(Number(completedReceipt.vat_amount) || 0))}</span></div>
                <div className="pos-receipt-total">
                  <span>TOTAL</span>
                  <span>{fmt(completedReceipt.total)}</span>
                </div>

                {/* ── Payment details ── */}
                <div className="pos-receipt-row"><span>Cash Received</span><span>{fmt(completedReceipt.amount_received)}</span></div>
                <div className="pos-receipt-row"><span>Change</span><span>{fmt(completedReceipt.change)}</span></div>


                {/* ── Footer ── */}
                <div className="pos-receipt-footer">
                  Thank you for shopping with us!<br />
                  Please keep this receipt.
                </div>
              </div>
            </div>
            <div className="pos-modal-footer">
              <button className="pos-btn-secondary" onClick={() => setCompletedReceipt(null)}>Close</button>
              <button className="pos-btn-primary" onClick={handlePrint}>
                <FontAwesomeIcon icon={faPrint} /> Print Receipt
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Photo Modal ───────────────────────────────────── */}
      {viewPhotoUrl && (
        <div className="pos-photo-overlay" onClick={() => setViewPhotoUrl(null)}>
          <div className="pos-photo-box" onClick={e => e.stopPropagation()}>
            <button className="pos-photo-close" onClick={() => setViewPhotoUrl(null)}>
              <FontAwesomeIcon icon={faXmark} />
            </button>
            <img className="pos-photo-img" src={viewPhotoUrl} alt="Product" />
          </div>
        </div>
      )}

      {/* ── Help Modal ────────────────────────────────────── */}
      {showHelp && (
        <div className="pos-overlay" onClick={() => setShowHelp(false)}>
          <div className="pos-modal pos-modal--sm" onClick={e => e.stopPropagation()}>
            <div className="pos-modal-header">
              <div className="pos-modal-title"><FontAwesomeIcon icon={faKeyboard} style={{ marginRight: 8 }} />Keyboard Shortcuts</div>
              <button className="pos-modal-close" onClick={() => setShowHelp(false)}><FontAwesomeIcon icon={faXmark} /></button>
            </div>
            <div className="pos-modal-body">
              <div className="pos-help-grid">
                {[
                  ["F1", "Open this help"],
                  ["F2", "Focus search bar"],
                  ["F3", "Clear cart"],
                  ["F4", "Open payment"],
                  ["Esc", "Cancel / close"],
                  ["Enter", "Add scanned product"],
                ].map(([key, desc]) => (
                  <div className="pos-help-row" key={key}>
                    <kbd className="pos-help-key">{key}</kbd>
                    <span className="pos-help-desc">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Toasts ────────────────────────────────────────── */}
      <div className="pos-toast-wrap">
        {toasts.map(t => (
          <div key={t.id} className={`pos-toast pos-toast--${t.type}`}>
            <FontAwesomeIcon icon={
              t.type === "success" ? faCheckCircle :
              t.type === "error"   ? faXmark :
              t.type === "warn"    ? faTriangleExclamation :
              faBolt
            } />
            {t.message}
            <div className="pos-toast-bar" />
          </div>
        ))}
      </div>
    </>
  );
};

export default CashierPOS;
